import os
import io
from datetime import date
from flask import Flask, render_template, request, redirect, url_for, session, send_file, flash
from flask_sqlalchemy import SQLAlchemy
from openpyxl import Workbook
from telegram import Bot

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv("DATABASE_URL", f"sqlite:///{os.path.join(BASE_DIR, 'portal.db')}")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "super-secret-key")

db = SQLAlchemy(app)

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    phone = db.Column(db.String(30), unique=True, nullable=False)
    password = db.Column(db.String(120), nullable=False)
    group_id = db.Column(db.Integer, db.ForeignKey('group.id'))

class Group(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    curator = db.Column(db.String(120), nullable=False)
    owner = db.relationship('User', backref='group', uselist=False)
    members = db.relationship('Member', backref='group', cascade='all, delete-orphan')

class Member(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    group_id = db.Column(db.Integer, db.ForeignKey('group.id'), nullable=False)
    attendances = db.relationship('Attendance', backref='member', cascade='all, delete-orphan')

class Attendance(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.String(20), nullable=False)
    member_id = db.Column(db.Integer, db.ForeignKey('member.id'), nullable=False)
    present = db.Column(db.Boolean, nullable=False)

with app.app_context():
    db.create_all()


def current_user():
    user_id = session.get('user_id')
    if not user_id:
        return None
    return User.query.get(user_id)


@app.context_processor
def inject_user():
    return {"current_user": current_user()}


def send_telegram_message(text: str):
    token = os.getenv('TELEGRAM_BOT_TOKEN')
    chat_id = os.getenv('TELEGRAM_CHAT_ID')
    if not token or not chat_id:
        return False
    bot = Bot(token=token)
    bot.send_message(chat_id=chat_id, text=text)
    return True

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        phone = request.form.get('phone', '').strip()
        password = request.form.get('password', '').strip()
        group_name = request.form.get('group_name', '').strip()
        curator = request.form.get('curator', '').strip()
        members_text = request.form.get('members', '').strip()

        if not (name and phone and password and group_name and curator and members_text):
            flash('Заполните все поля регистрации.', 'error')
            return redirect(url_for('register'))

        if User.query.filter_by(phone=phone).first():
            flash('Пользователь с таким номером телефона уже зарегистрирован.', 'error')
            return redirect(url_for('register'))

        group = Group(name=group_name, curator=curator)
        db.session.add(group)
        db.session.commit()

        user = User(name=name, phone=phone, password=password, group_id=group.id)
        db.session.add(user)

        for line in members_text.splitlines():
            member_name = line.strip()
            if member_name:
                member = Member(name=member_name, group_id=group.id)
                db.session.add(member)

        db.session.commit()
        session['user_id'] = user.id
        flash('Регистрация прошла успешно. Добро пожаловать!', 'success')
        return redirect(url_for('dashboard'))

    return render_template('register.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        phone = request.form.get('phone', '').strip()
        password = request.form.get('password', '').strip()
        user = User.query.filter_by(phone=phone, password=password).first()
        if not user:
            flash('Неправильный номер телефона или пароль.', 'error')
            return redirect(url_for('login'))
        session['user_id'] = user.id
        return redirect(url_for('dashboard'))
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.pop('user_id', None)
    return redirect(url_for('index'))

@app.route('/dashboard')
def dashboard():
    user = current_user()
    if not user:
        return redirect(url_for('login'))
    group = Group.query.get(user.group_id)
    members = group.members if group else []
    attendance_dates = sorted({att.date for m in members for att in m.attendances})
    return render_template('dashboard.html', user=user, group=group, members=members, attendance_dates=attendance_dates)

@app.route('/attendance', methods=['GET', 'POST'])
def attendance():
    user = current_user()
    if not user:
        return redirect(url_for('login'))
    group = Group.query.get(user.group_id)
    if not group:
        return redirect(url_for('dashboard'))
    members = group.members
    today = date.today().isoformat()

    if request.method == 'POST':
        for member in members:
            present = request.form.get(f'member_{member.id}') == 'on'
            attendance = Attendance.query.filter_by(member_id=member.id, date=today).first()
            if attendance:
                attendance.present = present
            else:
                attendance = Attendance(date=today, member_id=member.id, present=present)
                db.session.add(attendance)
        db.session.commit()

        report_lines = [f"Отметка посещаемости за {today}:"]
        for member in members:
            attendance = Attendance.query.filter_by(member_id=member.id, date=today).first()
            status = '✔️ присутствовал' if attendance and attendance.present else '❌ отсутствовал'
            report_lines.append(f"{member.name}: {status}")
        report_text = '\n'.join(report_lines)
        if send_telegram_message(report_text):
            flash('Посещаемость сохранена и отправлена в Telegram.', 'success')
        else:
            flash('Посещаемость сохранена. Telegram не настроен.', 'success')
        return redirect(url_for('dashboard'))

    attendance_by_member = {m.id: None for m in members}
    for member in members:
        att = Attendance.query.filter_by(member_id=member.id, date=today).first()
        attendance_by_member[member.id] = att.present if att else False

    return render_template('attendance.html', group=group, members=members, today=today, attendance_by_member=attendance_by_member)

@app.route('/export')
def export():
    user = current_user()
    if not user:
        return redirect(url_for('login'))
    group = Group.query.get(user.group_id)
    if not group:
        return redirect(url_for('dashboard'))
    members = group.members
    dates = sorted({att.date for member in members for att in member.attendances})

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = 'Отчет по посещаемости'
    sheet.append(['ФИО учащегося', 'Группа', 'Куратор'] + dates)

    for member in members:
        row = [member.name, group.name, group.curator]
        for report_date in dates:
            att = Attendance.query.filter_by(member_id=member.id, date=report_date).first()
            row.append('✔' if att and att.present else '❌')
        sheet.append(row)

    output = io.BytesIO()
    workbook.save(output)
    output.seek(0)
    return send_file(output, download_name='attendance_report.xlsx', as_attachment=True, mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

if __name__ == '__main__':
    app.run(debug=True)
