import { Router } from 'express';
import healthRoutes from './health.routes';
import webhookRoutes from './webhook.routes';
import authRoutes from './auth.routes';
import agentRoutes from './agent.routes';
import browserRoutes from './browser.routes';
import handoffRoutes from './handoff.routes';
import { createReminderRouter, createUserRouter } from './reminder.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/webhook', webhookRoutes);
router.use('/api/auth', authRoutes);
router.use('/auth', authRoutes);
router.use('/api/agent', agentRoutes);
router.use('/api/browser', browserRoutes);
router.use('/handoff', handoffRoutes);
router.use('/api/reminders', createReminderRouter());
router.use('/api/users', createUserRouter());

export default router;
