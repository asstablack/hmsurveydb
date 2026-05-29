const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

function cleanEnvValue(value) {
    if (!value) return '';
    return String(value).trim().replace(/^["']|["']$/g, '');
}

function getEnvValue(...names) {
    for (const name of names) {
        const value = cleanEnvValue(process.env[name]);
        if (value) return value;
    }
    return '';
}

function getEnvNumber(fallback, ...names) {
    const value = getEnvValue(...names);
    const number = Number(value || fallback);
    return Number.isFinite(number) ? number : fallback;
}

const dbConfig = {
    host: getEnvValue('DB_HOST', 'MYSQLHOST') || 'localhost',
    port: getEnvNumber(3306, 'DB_PORT', 'MYSQLPORT'),
    user: getEnvValue('DB_USER', 'MYSQLUSER') || 'root',
    password: getEnvValue('DB_PASSWORD', 'MYSQLPASSWORD'),
    database: getEnvValue('DB_NAME', 'MYSQLDATABASE') || 'survey_record_management'
};

const appBaseUrl = getEnvValue('APP_BASE_URL', 'PUBLIC_URL') || '';
const emailConfig = {
    user: getEnvValue('EMAIL_USER'),
    pass: getEnvValue('EMAIL_PASS'),
    from: getEnvValue('EMAIL_FROM') || getEnvValue('EMAIL_USER'),
    service: getEnvValue('EMAIL_SERVICE') || 'gmail',
    host: getEnvValue('EMAIL_HOST'),
    port: getEnvNumber(587, 'EMAIL_PORT')
};

function validateDatabaseConfig() {
    const unresolvedValue = Object.values(dbConfig).find((value) => String(value).includes('${{'));
    if (unresolvedValue) {
        throw new Error('Database environment variables are not resolving. Check the MySQL service name in Railway variables.');
    }

    if (!dbConfig.host || !dbConfig.user || !dbConfig.database) {
        throw new Error('Missing database configuration. Set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, and DB_PORT.');
    }
}

const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { salt, hash };
}

function verifyPassword(password, user) {
    const { hash } = hashPassword(password, user.password_salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.password_hash, 'hex'));
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function getPublicBaseUrl(req) {
    if (appBaseUrl) return appBaseUrl.replace(/\/$/, '');
    return `${req.protocol}://${req.get('host')}`;
}

function createMailTransport() {
    if (!emailConfig.user || !emailConfig.pass || !emailConfig.from) return null;

    if (emailConfig.host) {
        return nodemailer.createTransport({
            host: emailConfig.host,
            port: emailConfig.port,
            secure: emailConfig.port === 465,
            auth: {
                user: emailConfig.user,
                pass: emailConfig.pass
            }
        });
    }

    return nodemailer.createTransport({
        service: emailConfig.service,
        auth: {
            user: emailConfig.user,
            pass: emailConfig.pass
        }
    });
}

async function sendEmail(to, subject, text) {
    const transport = createMailTransport();
    if (!transport) {
        console.warn(`Email not configured. Skipped email to ${to}: ${subject}`);
        return false;
    }

    await transport.sendMail({
        from: emailConfig.from,
        to,
        subject,
        text
    });
    return true;
}

async function sendEmailSafe(to, subject, text) {
    try {
        return await sendEmail(to, subject, text);
    } catch (error) {
        console.warn(`Email failed for ${to}: ${error.message}`);
        return false;
    }
}

function toApiUser(user) {
    return {
        id: user.id,
        name: user.full_name,
        username: user.username,
        email: user.email,
        role: user.role,
        status: user.status,
        adminRequestId: user.admin_request_id || null,
        adminRequestStatus: user.admin_request_status || null,
        adminRequestRequestedAt: user.admin_request_requested_at || null,
        createdAt: user.created_at,
        approvedAt: user.approved_at
    };
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

function normalizeSurvey(row) {
    if (!row) return null;

    try {
        return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    } catch (error) {
        return {
            id: row.id,
            surveyNumber: row.survey_number,
            surveyName: row.survey_name,
            surveyor: row.surveyor
        };
    }
}

async function ensureDatabase() {
    validateDatabaseConfig();

    if (['localhost', '127.0.0.1'].includes(dbConfig.host)) {
        const bootstrap = await mysql.createConnection({
            host: dbConfig.host,
            port: dbConfig.port,
            user: dbConfig.user,
            password: dbConfig.password
        });

        await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
        await bootstrap.end();
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS surveys (
            id BIGINT PRIMARY KEY,
            survey_number VARCHAR(100) NOT NULL UNIQUE,
            survey_name VARCHAR(255) NOT NULL,
            surveyor VARCHAR(150) NOT NULL,
            local_gov VARCHAR(150),
            job_type VARCHAR(100),
            survey_date DATE,
            easting DOUBLE,
            northing DOUBLE,
            payload JSON NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_survey_number (survey_number),
            INDEX idx_survey_name (survey_name),
            INDEX idx_surveyor (surveyor),
            INDEX idx_survey_date (survey_date)
        )
    `);

    await pool.query('ALTER TABLE surveys MODIFY easting DOUBLE');
    await pool.query('ALTER TABLE surveys MODIFY northing DOUBLE');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            full_name VARCHAR(150) NOT NULL,
            username VARCHAR(100) NOT NULL UNIQUE,
            email VARCHAR(160) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            password_salt VARCHAR(64) NOT NULL,
            role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
            status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
            approved_by INT NULL,
            approved_at TIMESTAMP NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            action VARCHAR(80) NOT NULL,
            entity_type VARCHAR(80) NOT NULL,
            entity_id VARCHAR(120),
            actor_id INT NULL,
            actor_name VARCHAR(150),
            actor_role VARCHAR(50),
            details JSON,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_audit_action (action),
            INDEX idx_audit_actor_id (actor_id),
            INDEX idx_audit_created_at (created_at)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_role_requests (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
            requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            resolved_by INT NULL,
            resolved_at TIMESTAMP NULL,
            INDEX idx_admin_request_user (user_id),
            INDEX idx_admin_request_status (status),
            CONSTRAINT fk_admin_request_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            token_hash VARCHAR(128) NOT NULL UNIQUE,
            expires_at TIMESTAMP NOT NULL,
            used_at TIMESTAMP NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_reset_user (user_id),
            INDEX idx_reset_expires (expires_at),
            CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    const [admins] = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (!admins.length) {
        const password = hashPassword('mercy123');
        await pool.execute(
            `INSERT INTO users
                (full_name, username, email, password_hash, password_salt, role, status, approved_at)
             VALUES (?, ?, ?, ?, ?, 'admin', 'approved', CURRENT_TIMESTAMP)`,
            ['HISMERCY', 'His Mercy', 'admin@survey.local', password.hash, password.salt]
        );
    }
}

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'survey-record-management-backend' });
});

app.post('/api/auth/register', async (req, res, next) => {
    try {
        const fullName = String(req.body.fullName || '').trim();
        const username = String(req.body.username || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const passwordText = String(req.body.password || '');

        if (!fullName || !username || !email || passwordText.length < 6) {
            return res.status(400).json({ message: 'Full name, username, email, and a 6 character password are required' });
        }

        const password = hashPassword(passwordText);
        await pool.execute(
            `INSERT INTO users (full_name, username, email, password_hash, password_salt)
             VALUES (?, ?, ?, ?, ?)`,
            [fullName, username, email, password.hash, password.salt]
        );

        res.status(201).json({ message: 'Registration submitted. Wait for administrator approval.' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Username or email already exists' });
        }
        next(error);
    }
});

app.post('/api/auth/login', async (req, res, next) => {
    try {
        const username = String(req.body.username || '').trim();
        const password = String(req.body.password || '');

        const [users] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
        if (!users.length || !verifyPassword(password, users[0])) {
            return res.status(401).json({ message: 'Invalid username or password' });
        }

        if (users[0].status !== 'approved') {
            return res.status(403).json({ message: `Your account is ${users[0].status}. Contact the administrator.` });
        }

        res.json({ user: toApiUser(users[0]) });
    } catch (error) {
        next(error);
    }
});

app.put('/api/auth/change-password', async (req, res, next) => {
    try {
        const userId = req.body.userId;
        const currentPassword = String(req.body.currentPassword || '');
        const newPassword = String(req.body.newPassword || '');

        if (!userId || !currentPassword || newPassword.length < 6) {
            return res.status(400).json({ message: 'Current password and a new 6 character password are required' });
        }

        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
        if (!users.length || !verifyPassword(currentPassword, users[0])) {
            return res.status(401).json({ message: 'Current password is incorrect' });
        }

        const password = hashPassword(newPassword);
        await pool.execute(
            'UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?',
            [password.hash, password.salt, userId]
        );

        await pool.execute(
            `INSERT INTO audit_logs
                (action, entity_type, entity_id, actor_id, actor_name, actor_role, details)
             VALUES ('password_changed', 'user', ?, ?, ?, ?, CAST(? AS JSON))`,
            [
                userId,
                userId,
                users[0].full_name,
                users[0].role,
                JSON.stringify({ mode: 'self_service' })
            ]
        );

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/forgot-password', async (req, res, next) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const genericMessage = 'If the email is linked to an approved account, a password reset link has been sent.';
        const [users] = await pool.execute(
            "SELECT id, full_name, email FROM users WHERE email = ? AND status = 'approved' LIMIT 1",
            [email]
        );

        if (!users.length) {
            return res.json({ message: genericMessage });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = hashToken(token);
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        const resetUrl = `${getPublicBaseUrl(req)}/?resetToken=${token}`;

        await pool.execute('DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL', [users[0].id]);
        await pool.execute(
            'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
            [users[0].id, tokenHash, expiresAt]
        );

        const emailSent = await sendEmailSafe(
            users[0].email,
            'HM SurveyDB password reset',
            `Hello ${users[0].full_name},\n\nUse this link to reset your password:\n${resetUrl}\n\nThis link expires in 30 minutes. If you did not request this, ignore this email.`
        );

        const response = { message: genericMessage, emailSent };
        if (!emailSent && process.env.NODE_ENV !== 'production') {
            response.resetToken = token;
        }

        res.json(response);
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/reset-password', async (req, res, next) => {
    try {
        const token = String(req.body.token || '').trim();
        const newPassword = String(req.body.newPassword || '');

        if (!token || newPassword.length < 6) {
            return res.status(400).json({ message: 'Reset token and a new 6 character password are required' });
        }

        const [tokens] = await pool.execute(
            `SELECT prt.id, prt.user_id, u.full_name, u.email, u.role
             FROM password_reset_tokens prt
             JOIN users u ON u.id = prt.user_id
             WHERE prt.token_hash = ? AND prt.used_at IS NULL AND prt.expires_at > CURRENT_TIMESTAMP
             LIMIT 1`,
            [hashToken(token)]
        );

        if (!tokens.length) {
            return res.status(400).json({ message: 'Password reset link is invalid or expired' });
        }

        const password = hashPassword(newPassword);
        await pool.execute(
            'UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?',
            [password.hash, password.salt, tokens[0].user_id]
        );
        await pool.execute('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [tokens[0].id]);
        await pool.execute(
            `INSERT INTO audit_logs
                (action, entity_type, entity_id, actor_id, actor_name, actor_role, details)
             VALUES ('password_reset', 'user', ?, ?, ?, ?, CAST(? AS JSON))`,
            [
                tokens[0].user_id,
                tokens[0].user_id,
                tokens[0].full_name,
                tokens[0].role,
                JSON.stringify({ mode: 'email_reset' })
            ]
        );

        await sendEmailSafe(
            tokens[0].email,
            'HM SurveyDB password changed',
            `Hello ${tokens[0].full_name},\n\nYour HM SurveyDB password was changed successfully. If this was not you, contact an administrator immediately.`
        );

        res.json({ message: 'Password reset successfully. You can now log in.' });
    } catch (error) {
        next(error);
    }
});

app.get('/api/users', async (req, res, next) => {
    try {
        const [users] = await pool.query(
            `SELECT u.id, u.full_name, u.username, u.email, u.role, u.status, u.created_at, u.approved_at,
                    arr.id AS admin_request_id,
                    arr.status AS admin_request_status,
                    arr.requested_at AS admin_request_requested_at
             FROM users u
             LEFT JOIN admin_role_requests arr
                ON arr.user_id = u.id
               AND arr.id = (
                    SELECT MAX(id) FROM admin_role_requests latest WHERE latest.user_id = u.id
               )
             ORDER BY u.status = 'pending' DESC, arr.status = 'pending' DESC, u.created_at DESC`
        );
        res.json({ users: users.map(toApiUser) });
    } catch (error) {
        next(error);
    }
});

app.get('/api/audit-logs', async (req, res, next) => {
    try {
        const [logs] = await pool.query(
            `SELECT id, action, entity_type, entity_id, actor_id, actor_name, actor_role, details, created_at
             FROM audit_logs ORDER BY created_at DESC LIMIT 100`
        );
        res.json({ logs });
    } catch (error) {
        next(error);
    }
});

app.post('/api/audit-logs', async (req, res, next) => {
    try {
        await pool.execute(
            `INSERT INTO audit_logs
                (action, entity_type, entity_id, actor_id, actor_name, actor_role, details)
             VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
            [
                req.body.action || 'unknown',
                req.body.entityType || 'unknown',
                req.body.entityId || null,
                req.body.actorId || null,
                req.body.actorName || null,
                req.body.actorRole || null,
                JSON.stringify(req.body.details || {})
            ]
        );
        res.status(201).json({ message: 'Audit log saved' });
    } catch (error) {
        next(error);
    }
});

app.put('/api/users/:id/status', async (req, res, next) => {
    try {
        const status = String(req.body.status || '').trim();
        const adminId = req.body.adminId || null;

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Status must be approved or rejected' });
        }

        const [targetUsers] = await pool.execute(
            "SELECT id, full_name, email FROM users WHERE id = ? AND role <> 'admin'",
            [req.params.id]
        );
        if (!targetUsers.length) {
            return res.status(404).json({ message: 'User not found or cannot update administrator' });
        }

        const [result] = await pool.execute(
            `UPDATE users
             SET status = ?, approved_by = ?, approved_at = IF(? = 'approved', CURRENT_TIMESTAMP, approved_at)
             WHERE id = ? AND role <> 'admin'`,
            [status, adminId, status, req.params.id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ message: 'User not found or cannot update administrator' });
        }

        await pool.execute(
            `INSERT INTO audit_logs
                (action, entity_type, entity_id, actor_id, actor_name, actor_role, details)
             VALUES (?, 'user', ?, ?, ?, 'admin', CAST(? AS JSON))`,
            [
                `user_${status}`,
                req.params.id,
                adminId,
                req.body.adminName || null,
                JSON.stringify({ status })
            ]
        );

        await sendEmailSafe(
            targetUsers[0].email,
            `HM SurveyDB account ${status}`,
            status === 'approved'
                ? `Hello ${targetUsers[0].full_name},\n\nYour HM SurveyDB account has been approved. You can now log in.`
                : `Hello ${targetUsers[0].full_name},\n\nYour HM SurveyDB account request was rejected. Contact the administrator if you believe this is a mistake.`
        );

        res.json({ message: `User ${status}` });
    } catch (error) {
        next(error);
    }
});

app.post('/api/users/:id/admin-request', async (req, res, next) => {
    try {
        const userId = Number(req.params.id);
        const bodyUserId = Number(req.body.userId || userId);

        if (!userId || userId !== bodyUserId) {
            return res.status(400).json({ message: 'Invalid user request' });
        }

        const [users] = await pool.execute(
            "SELECT id, full_name, email, role, status FROM users WHERE id = ?",
            [userId]
        );
        if (!users.length) {
            return res.status(404).json({ message: 'User not found' });
        }
        if (users[0].status !== 'approved') {
            return res.status(403).json({ message: 'Only approved users can request admin access' });
        }
        if (users[0].role === 'admin') {
            return res.status(400).json({ message: 'This user is already an administrator' });
        }

        const [existing] = await pool.execute(
            "SELECT id FROM admin_role_requests WHERE user_id = ? AND status = 'pending' LIMIT 1",
            [userId]
        );
        if (existing.length) {
            return res.status(409).json({ message: 'Admin role request is already pending' });
        }

        const [result] = await pool.execute(
            "INSERT INTO admin_role_requests (user_id, status) VALUES (?, 'pending')",
            [userId]
        );

        await pool.execute(
            `INSERT INTO audit_logs
                (action, entity_type, entity_id, actor_id, actor_name, actor_role, details)
             VALUES ('admin_role_requested', 'user', ?, ?, ?, ?, CAST(? AS JSON))`,
            [
                userId,
                userId,
                users[0].full_name,
                users[0].role,
                JSON.stringify({ requestId: result.insertId })
            ]
        );

        res.status(201).json({ message: 'Admin role request submitted for approval' });
    } catch (error) {
        next(error);
    }
});

app.put('/api/admin-requests/:id/status', async (req, res, next) => {
    const connection = await pool.getConnection();
    try {
        const requestId = req.params.id;
        const status = String(req.body.status || '').trim();
        const adminId = req.body.adminId || null;
        const adminName = req.body.adminName || null;

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Status must be approved or rejected' });
        }

        const [admins] = await connection.execute(
            "SELECT id FROM users WHERE id = ? AND role = 'admin' AND status = 'approved'",
            [adminId]
        );
        if (!admins.length) {
            return res.status(403).json({ message: 'Only an approved administrator can handle admin requests' });
        }

        await connection.beginTransaction();
        const [requests] = await connection.execute(
            `SELECT arr.id, arr.user_id, u.full_name, u.email, u.role
             FROM admin_role_requests arr
             JOIN users u ON u.id = arr.user_id
             WHERE arr.id = ? AND arr.status = 'pending'
             LIMIT 1`,
            [requestId]
        );

        if (!requests.length) {
            await connection.rollback();
            return res.status(404).json({ message: 'Pending admin role request not found' });
        }

        await connection.execute(
            `UPDATE admin_role_requests
             SET status = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [status, adminId, requestId]
        );

        if (status === 'approved') {
            await connection.execute("UPDATE users SET role = 'admin' WHERE id = ?", [requests[0].user_id]);
        }

        await connection.execute(
            `INSERT INTO audit_logs
                (action, entity_type, entity_id, actor_id, actor_name, actor_role, details)
             VALUES (?, 'user', ?, ?, ?, 'admin', CAST(? AS JSON))`,
            [
                `admin_role_${status}`,
                requests[0].user_id,
                adminId,
                adminName,
                JSON.stringify({ requestId })
            ]
        );

        await connection.commit();

        await sendEmailSafe(
            requests[0].email,
            `HM SurveyDB admin request ${status}`,
            status === 'approved'
                ? `Hello ${requests[0].full_name},\n\nYour request for administrator access has been approved. Log out and log back in to see admin tools.`
                : `Hello ${requests[0].full_name},\n\nYour request for administrator access was rejected. Contact an administrator for more details.`
        );

        res.json({ message: `Admin role request ${status}` });
    } catch (error) {
        await connection.rollback();
        next(error);
    } finally {
        connection.release();
    }
});

app.put('/api/users/:id/role', async (req, res, next) => {
    try {
        const role = String(req.body.role || '').trim();
        const adminId = req.body.adminId || null;
        const adminName = req.body.adminName || null;

        if (!['admin', 'user'].includes(role)) {
            return res.status(400).json({ message: 'Role must be admin or user' });
        }

        const [admins] = await pool.execute(
            "SELECT id FROM users WHERE id = ? AND role = 'admin' AND status = 'approved'",
            [adminId]
        );
        if (!admins.length) {
            return res.status(403).json({ message: 'Only an approved administrator can change user roles' });
        }
        if (String(adminId) === String(req.params.id) && role !== 'admin') {
            return res.status(400).json({ message: 'You cannot remove your own administrator role' });
        }

        const [targetUsers] = await pool.execute(
            'SELECT id, full_name, email, role, status FROM users WHERE id = ?',
            [req.params.id]
        );
        if (!targetUsers.length) {
            return res.status(404).json({ message: 'User not found' });
        }
        if (targetUsers[0].status !== 'approved') {
            return res.status(400).json({ message: 'Only approved users can be promoted' });
        }

        await pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
        await pool.execute(
            `INSERT INTO audit_logs
                (action, entity_type, entity_id, actor_id, actor_name, actor_role, details)
             VALUES ('user_role_changed', 'user', ?, ?, ?, 'admin', CAST(? AS JSON))`,
            [
                req.params.id,
                adminId,
                adminName,
                JSON.stringify({ from: targetUsers[0].role, to: role })
            ]
        );

        await sendEmailSafe(
            targetUsers[0].email,
            'HM SurveyDB role updated',
            `Hello ${targetUsers[0].full_name},\n\nYour HM SurveyDB role has been changed to ${role}.`
        );

        res.json({ message: `User role changed to ${role}` });
    } catch (error) {
        next(error);
    }
});

app.put('/api/users/:id/password', async (req, res, next) => {
    try {
        const adminId = req.body.adminId || null;
        const adminName = req.body.adminName || null;
        const newPassword = String(req.body.newPassword || '');

        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'New password must be at least 6 characters' });
        }

        const [admins] = await pool.execute(
            "SELECT id FROM users WHERE id = ? AND role = 'admin' AND status = 'approved'",
            [adminId]
        );
        if (!admins.length) {
            return res.status(403).json({ message: 'Only an approved administrator can reset passwords' });
        }

        const password = hashPassword(newPassword);
        const [result] = await pool.execute(
            'UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?',
            [password.hash, password.salt, req.params.id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ message: 'User not found' });
        }

        await pool.execute(
            `INSERT INTO audit_logs
                (action, entity_type, entity_id, actor_id, actor_name, actor_role, details)
             VALUES ('password_reset', 'user', ?, ?, ?, 'admin', CAST(? AS JSON))`,
            [
                req.params.id,
                adminId,
                adminName,
                JSON.stringify({ mode: 'admin_reset' })
            ]
        );

        res.json({ message: 'Password reset successfully' });
    } catch (error) {
        next(error);
    }
});

app.get('/api/surveys', async (req, res, next) => {
    try {
        const [rows] = await pool.query('SELECT payload FROM surveys ORDER BY created_at DESC, id DESC');
        res.json({ surveys: rows.map(normalizeSurvey) });
    } catch (error) {
        next(error);
    }
});

app.get('/api/surveys/:id', async (req, res, next) => {
    try {
        const [rows] = await pool.execute('SELECT payload FROM surveys WHERE id = ?', [req.params.id]);

        if (!rows.length) {
            return res.status(404).json({ message: 'Survey record not found' });
        }

        res.json({ survey: normalizeSurvey(rows[0]) });
    } catch (error) {
        next(error);
    }
});

app.put('/api/surveys/bulk', async (req, res, next) => {
    const surveys = Array.isArray(req.body.surveys) ? req.body.surveys : null;

    if (!surveys) {
        return res.status(400).json({ message: 'surveys must be an array' });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        await connection.query('DELETE FROM surveys');

        for (const survey of surveys) {
            if (!survey.id || !survey.surveyNumber || !survey.surveyName || !survey.surveyor) {
                throw Object.assign(new Error('Each survey needs id, surveyNumber, surveyName, and surveyor'), {
                    statusCode: 400
                });
            }

            await connection.execute(
                `INSERT INTO surveys
                    (id, survey_number, survey_name, surveyor, local_gov, job_type, survey_date, easting, northing, payload)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
                [
                    survey.id,
                    survey.surveyNumber,
                    survey.surveyName,
                    survey.surveyor,
                    survey.localGov || null,
                    survey.jobType || null,
                    survey.surveyDate || null,
                    survey.easting ?? null,
                    survey.northing ?? null,
                    JSON.stringify(survey)
                ]
            );
        }

        await connection.commit();
        res.json({ message: 'Survey records synced', count: surveys.length });
    } catch (error) {
        await connection.rollback();
        next(error);
    } finally {
        connection.release();
    }
});

app.post('/api/surveys', async (req, res, next) => {
    try {
        const survey = req.body;

        if (!survey.id || !survey.surveyNumber || !survey.surveyName || !survey.surveyor) {
            return res.status(400).json({ message: 'id, surveyNumber, surveyName, and surveyor are required' });
        }

        await pool.execute(
            `INSERT INTO surveys
                (id, survey_number, survey_name, surveyor, local_gov, job_type, survey_date, easting, northing, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))
             ON DUPLICATE KEY UPDATE
                survey_number = VALUES(survey_number),
                survey_name = VALUES(survey_name),
                surveyor = VALUES(surveyor),
                local_gov = VALUES(local_gov),
                job_type = VALUES(job_type),
                survey_date = VALUES(survey_date),
                easting = VALUES(easting),
                northing = VALUES(northing),
                payload = VALUES(payload)`,
            [
                survey.id,
                survey.surveyNumber,
                survey.surveyName,
                survey.surveyor,
                survey.localGov || null,
                survey.jobType || null,
                survey.surveyDate || null,
                survey.easting ?? null,
                survey.northing ?? null,
                JSON.stringify(survey)
            ]
        );

        res.status(201).json({ survey });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/surveys/:id', async (req, res, next) => {
    try {
        const [result] = await pool.execute('DELETE FROM surveys WHERE id = ?', [req.params.id]);

        if (!result.affectedRows) {
            return res.status(404).json({ message: 'Survey record not found' });
        }

        res.status(204).send();
    } catch (error) {
        next(error);
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.use((req, res) => {
    res.status(404).json({ message: 'Route not found' });
});

app.use((error, req, res, next) => {
    console.error(error);
    res.status(error.statusCode || 500).json({
        message: error.statusCode ? error.message : 'Server error'
    });
});

ensureDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server is live at http://localhost:${PORT}`);
        });
    })
    .catch((error) => {
        console.error('Unable to start server. Check your MySQL settings.');
        console.error(error && error.stack ? error.stack : error);
        process.exit(1);
    });
