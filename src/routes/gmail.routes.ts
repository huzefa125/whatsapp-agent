import { Router } from 'express';
import { gmailOAuthCallbackController } from '../controllers/gmail.controller';

const router = Router();

/**
 * GET /api/gmail/oauth/callback
 * Google redirects here after user consents. Exchanges code for tokens.
 */
router.get('/oauth/callback', gmailOAuthCallbackController);

export default router;
