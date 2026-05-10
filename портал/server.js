const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const ExcelJS = require('exceljs');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 5000;
const DB_FILE = process.env.DATABASE_URL
  ? process.env.DATABASE_URL.replace('sqlite:///', '')
  : path.join(__dirname, 'portal.db');

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, '');
}

const db = new sqlite3.Database(DB_FILE);

app.set('views', path.join(__dirname, 'templates'));
app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');
app.use('/static', (req, res, next) => {
  console.log('Request to static file:', req.path);
  next();
}, express.static(path.join(__dirname, 'static')));
console.log('Static files served from /static:', path.join(__dirname, 'static'));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: process.env.SECRET_KEY || 'super-secret-key',
    resave: false,
    saveUninitialized: false,
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.userId || null;
  res.locals.error = req.session.flash && req.session.flash.error;
  res.locals.success = req.session.flash && req.session.flash.success;
  delete req.session.flash;
  next();
});

function initDb() {
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        curator TEXT NOT NULL
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        group_id INTEGER,
        FOREIGN KEY (group_id) REFERENCES groups(id)
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        FOREIGN KEY (group_id) REFERENCES groups(id)
      )`
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        member_id INTEGER NOT NULL,
        present INTEGER NOT NULL,
        FOREIGN KEY (member_id) REFERENCES members(id)
      )`
    );
  });
}

initDb();

function getCurrentUser(req) {
  return new Promise((resolve, reject) => {
    const userId = req.session.userId;
    if (!userId) {
      return resolve(null);
    }
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

app.use(async (req, res, next) => {
  try {
    res.locals.currentUser = await getCurrentUser(req);
    next();
  } catch (error) {
    next(error);
  }
});

function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return Promise.resolve(false);
  }
  const bot = new TelegramBot(token, { polling: false });
  return bot.sendMessage(chatId, text).then(() => true).catch(() => false);
}

app.get('/check-static', (req, res) => {
  const staticPath = path.join(__dirname, 'static');
  const stylePath = path.join(staticPath, 'style.css');
  const exists = fs.existsSync(stylePath);
  res.json({
    staticDir: staticPath,
    styleExists: exists,
    files: fs.readdirSync(staticPath)
  });
});

app.get('/register', (req, res) => {
  res.render('register.html');
});

app.post('/register', (req, res) => {
  const { name, phone, password, group_name, curator, members } = req.body;
  if (!name || !phone || !password || !group_name || !curator || !members) {
    return res.render('register.html', { error: 'Заполните все поля регистрации.' });
  }

  db.get('SELECT id FROM users WHERE phone = ?', [phone], (err, existing) => {
    if (err) return res.status(500).send('Ошибка сервера');
    if (existing) {
      return res.render('register.html', { error: 'Пользователь с таким номером телефона уже зарегистрирован.' });
    }

    db.run(
      'INSERT INTO groups (name, curator) VALUES (?, ?)',
      [group_name, curator],
      function (groupErr) {
        if (groupErr) return res.status(500).send('Ошибка сервера');
        const groupId = this.lastID;
        db.run(
          'INSERT INTO users (name, phone, password, group_id) VALUES (?, ?, ?, ?)',
          [name, phone, password, groupId],
          function (userErr) {
            if (userErr) return res.status(500).send('Ошибка сервера');
            const userId = this.lastID;
            const memberNames = members
              .split('\n')
              .map((row) => row.trim())
              .filter(Boolean);
            const insertMember = db.prepare('INSERT INTO members (name, group_id) VALUES (?, ?)');
            memberNames.forEach((memberName) => {
              insertMember.run(memberName, groupId);
            });
            insertMember.finalize(() => {
              req.session.userId = userId;
              res.redirect('/dashboard');
            });
          }
        );
      }
    );
  });
});

app.get('/login', (req, res) => {
  res.render('login.html');
});

app.post('/login', (req, res) => {
  const { phone, password } = req.body;
  db.get('SELECT * FROM users WHERE phone = ? AND password = ?', [phone, password], (err, user) => {
    if (err) return res.status(500).send('Ошибка сервера');
    if (!user) {
      return res.render('login.html', { error: 'Неправильный номер телефона или пароль.' });
    }
    req.session.userId = user.id;
    res.redirect('/dashboard');
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

function fetchGroupMembers(groupId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM members WHERE group_id = ?', [groupId], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function fetchAttendanceForMembers(memberIds) {
  return new Promise((resolve, reject) => {
    if (!memberIds.length) return resolve([]);
    const placeholders = memberIds.map(() => '?').join(',');
    db.all(
      `SELECT * FROM attendance WHERE member_id IN (${placeholders})`,
      memberIds,
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      }
    );
  });
}

app.get('/dashboard', async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.redirect('/login');
    db.get('SELECT * FROM groups WHERE id = ?', [user.group_id], async (err, group) => {
      if (err) return next(err);
      const members = await fetchGroupMembers(group.id);
      const attendanceRows = await fetchAttendanceForMembers(members.map((m) => m.id));
      const attendanceDates = Array.from(new Set(attendanceRows.map((row) => row.date))).sort();
      const attendanceMap = attendanceRows.reduce((map, row) => {
        map[`${row.member_id}_${row.date}`] = row.present === 1;
        return map;
      }, {});
      members.forEach((member) => {
        member.attendance = attendanceDates.map((date) => attendanceMap[`${member.id}_${date}`] || false);
      });
      res.render('dashboard.html', { user, group, members, attendanceDates });
    });
  } catch (error) {
    next(error);
  }
});

app.get('/attendance', async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.redirect('/login');
    db.get('SELECT * FROM groups WHERE id = ?', [user.group_id], async (err, group) => {
      if (err) return next(err);
      const members = await fetchGroupMembers(group.id);
      const today = new Date().toISOString().slice(0, 10);
      const attendanceRows = await fetchAttendanceForMembers(members.map((m) => m.id));
      const attendanceMap = attendanceRows.reduce((map, row) => {
        if (row.date === today) {
          map[row.member_id] = row.present === 1;
        }
        return map;
      }, {});
      res.render('attendance.html', { group, members, today, attendanceMap });
    });
  } catch (error) {
    next(error);
  }
});

app.post('/attendance', async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.redirect('/login');
    db.get('SELECT * FROM groups WHERE id = ?', [user.group_id], async (err, group) => {
      if (err) return next(err);
      const members = await fetchGroupMembers(group.id);
      const today = new Date().toISOString().slice(0, 10);
      const reportLines = [`Отметка посещаемости за ${today}:`];
      let completed = 0;

      const finalizeAttendance = async () => {
        const reportText = reportLines.join('\n');
        const sent = await sendTelegramMessage(reportText);
        req.session.flash = {
          success: sent
            ? 'Посещаемость сохранена и отправлена в Telegram.'
            : 'Посещаемость сохранена. Telegram не настроен.',
        };
        res.redirect('/dashboard');
      };

      if (!members.length) {
        return finalizeAttendance();
      }

      db.serialize(() => {
        members.forEach((member) => {
          const present = req.body[`member_${member.id}`] === 'on' ? 1 : 0;
          db.get(
            'SELECT * FROM attendance WHERE member_id = ? AND date = ?',
            [member.id, today],
            (attendanceErr, attendanceRow) => {
              if (attendanceErr) return next(attendanceErr);
              if (attendanceRow) {
                db.run(
                  'UPDATE attendance SET present = ? WHERE member_id = ? AND date = ?',
                  [present, member.id, today],
                  (updateErr) => {
                    if (updateErr) return next(updateErr);
                    completed += 1;
                    if (completed === members.length) {
                      finalizeAttendance();
                    }
                  }
                );
              } else {
                db.run(
                  'INSERT INTO attendance (date, member_id, present) VALUES (?, ?, ?)',
                  [today, member.id, present],
                  (insertErr) => {
                    if (insertErr) return next(insertErr);
                    completed += 1;
                    if (completed === members.length) {
                      finalizeAttendance();
                    }
                  }
                );
              }
            }
          );
          reportLines.push(`${member.name}: ${present ? '✔️ присутствовал' : '❌ отсутствовал'}`);
        });

        const finalizeAttendance = async () => {
          const reportText = reportLines.join('\n');
          const sent = await sendTelegramMessage(reportText);
          req.session.flash = {
            success: sent
              ? 'Посещаемость сохранена и отправлена в Telegram.'
              : 'Посещаемость сохранена. Telegram не настроен.',
          };
          res.redirect('/dashboard');
        };
      });
    });
  } catch (error) {
    next(error);
  }
});

app.get('/export', async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) return res.redirect('/login');
    db.get('SELECT * FROM groups WHERE id = ?', [user.group_id], async (err, group) => {
      if (err) return next(err);
      const members = await fetchGroupMembers(group.id);
      const attendanceRows = await fetchAttendanceForMembers(members.map((m) => m.id));
      const dates = Array.from(new Set(attendanceRows.map((row) => row.date))).sort();
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Отчет по посещаемости');
      sheet.addRow(['ФИО учащегося', 'Группа', 'Куратор', ...dates]);

      members.forEach((member) => {
        const row = [member.name, group.name, group.curator];
        dates.forEach((date) => {
          const attendance = attendanceRows.find((att) => att.member_id === member.id && att.date === date);
          row.push(attendance && attendance.present === 1 ? '✔' : '❌');
        });
        sheet.addRow(row);
      });

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename=attendance_report.xlsx');
      await workbook.xlsx.write(res);
      res.end();
    });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).send('Страница не найдена');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Внутренняя ошибка сервера');
});

app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
