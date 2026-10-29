import { Router } from 'express';
import { HandoffController } from '../controllers/handoff.controller';

/**
 * Public routes of the remote sign-in. The set is fixed and small. There is intentionally no endpoint that accepts
 * a URL: the remote browser can only be pointed at the approved site by the server when the link is redeemed.
 */
const router = Router();

router.use(HandoffController.requireEnabled);

// Session routes first: "session" is never a valid token (tokens are 43 base64url characters).
router.get('/session', HandoffController.viewer);
router.get('/session/status', HandoffController.status);
router.get('/session/frame', HandoffController.frame);
router.post('/session/input', HandoffController.input);
router.post('/session/complete', HandoffController.complete);
router.post('/session/cancel', HandoffController.cancel);

router.get('/:token', HandoffController.preview);
router.post('/:token/start', HandoffController.start);

export default router;
