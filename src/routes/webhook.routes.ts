import { Router } from 'express';
import { WebhookController } from '../controllers/webhook.controller';

const router = Router();

router.get('/', WebhookController.verify);
router.post('/', (req, res, next) => {
  WebhookController.handleEvent(req, res, next).catch(next);
});

export default router;
