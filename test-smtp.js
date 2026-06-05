import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: 'e:/Clients Projects/MontseaumateII/.env' });

const user = process.env.EMAIL_USER;
const pass = process.env.EMAIL_PASS;

console.log('Testing SMTP with:', { user, passLength: pass ? pass.length : 0 });

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
});

transporter.verify((error, success) => {
    if (error) {
        console.error('SMTP Verification Failed:', error);
    } else {
        console.log('SMTP Server is ready to take our messages!');
    }
    process.exit(0);
});
