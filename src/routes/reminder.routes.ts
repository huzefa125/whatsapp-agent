import { Router } from 'express';
import { ReminderController } from '../controllers/reminder.controller';
import { requireAuth } from '../middleware/auth';
import { createUserWriteLimiter } from '../middleware/rate-limit';
import { getConfig } from '../config/env';

export function createReminderRouter(): Router {
  const config = getConfig();
  const router = Router();
  const writeLimit = createUserWriteLimiter({
    windowMs: config.REMINDER_RATE_LIMIT_WINDOW_MS,
    max: config.REMINDER_RATE_LIMIT_MAX,
  });

  router.use(requireAuth);

  router.get('/', ReminderController.list);
  router.get('/:id', ReminderController.get);
  router.post('/', writeLimit, ReminderController.create);
  router.patch('/:id', writeLimit, ReminderController.patch);
  router.delete('/:id', writeLimit, ReminderController.remove);

  return router;
}

export function createUserRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  router.patch('/me', ReminderController.setTimezone);
  return router;
}
