import cron from 'node-cron';
import { runWeeklyReportsJob } from '../services/reportService.js';

/**
 * Schedules the Weekly Report Job.
 * Runs every Monday at 09:00 AM.
 */
const startWeeklyReportCron = () => {
    // 0 9 * * 1 = 09:00 on Monday
    cron.schedule('0 9 * * 1', () => {
        console.log('[Cron] Triggering Weekly Reports Batch Job...');
        runWeeklyReportsJob();
    });

    console.log('✅ Weekly Report Cron Scheduler initialized (Mon 09:00 AM)');
};

export default startWeeklyReportCron;
