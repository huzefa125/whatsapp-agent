import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, conversations, messages, NewUser, NewConversation, NewMessage } from '../../db/schema';
import { getAiProvider, ChatMessage } from '../ai';
import { SYSTEM_PROMPT, buildCapabilityContext, formatUserMessageForModel } from './prompts';
import { ParsedTextMessageEvent } from '../whatsapp/types';
import { logger } from '../../utils/logger';

export interface AgentProcessResult {
  replyText: string;
  isDuplicate: boolean;
  userId?: string;
  conversationId?: string;
}

export class AgentOrchestrator {
  private historyLimit: number;

  constructor(historyLimit = 10) {
    this.historyLimit = historyLimit;
  }

  /**
   * Processes an incoming WhatsApp text message through the conversational AI pipeline.
   * Ensures absolute user and conversation isolation and idempotency.
   */
  async processTextMessage(event: ParsedTextMessageEvent): Promise<AgentProcessResult> {
    const db = getDb();
    const { senderPhoneNumber, senderName, text, providerMessageId } = event;

    // 1. Check for existing message with providerMessageId for idempotency
    if (providerMessageId) {
      const existingMessage = await db
        .select()
        .from(messages)
        .where(eq(messages.providerMessageId, providerMessageId))
        .limit(1);

      if (existingMessage.length > 0) {
        logger.info(
          { providerMessageId, sender: senderPhoneNumber },
          'Message already processed (idempotency hit); skipping AI generation'
        );
        return {
          replyText: '',
          isDuplicate: true,
        };
      }
    }

    // 2. Find or create User
    let user = (
      await db.select().from(users).where(eq(users.phoneNumber, senderPhoneNumber)).limit(1)
    )[0];

    if (!user) {
      const newUser: NewUser = {
        phoneNumber: senderPhoneNumber,
        displayName: senderName || null,
        metadata: {},
      };
      const inserted = await db.insert(users).values(newUser).returning();
      user = inserted[0];
      logger.info({ userId: user?.id, phone: senderPhoneNumber }, 'Created new user profile');
    } else if (senderName && user.displayName !== senderName) {
      // Update display name if it changed
      await db
        .update(users)
        .set({ displayName: senderName, updatedAt: new Date() })
        .where(eq(users.id, user.id));
    }

    if (!user) {
      throw new Error(`Failed to resolve or create user for phone: ${senderPhoneNumber}`);
    }

    // 3. Find or create active Conversation for this user
    let conversation = (
      await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.userId, user.id), eq(conversations.status, 'active')))
        .orderBy(desc(conversations.createdAt))
        .limit(1)
    )[0];

    if (!conversation) {
      const newConv: NewConversation = {
        userId: user.id,
        title: 'WhatsApp Chat',
        status: 'active',
        metadata: {},
      };
      const inserted = await db.insert(conversations).values(newConv).returning();
      conversation = inserted[0];
    }

    if (!conversation) {
      throw new Error(`Failed to resolve active conversation for user: ${user.id}`);
    }

    // 4. Record the inbound user message
    const inboundMessage: NewMessage = {
      conversationId: conversation.id,
      userId: user.id,
      role: 'user',
      content: text,
      providerMessageId: providerMessageId || null,
      status: 'received',
      metadata: { rawTimestamp: event.timestamp.toISOString() },
    };
    await db.insert(messages).values(inboundMessage);

    // 5. Fetch recent conversation history strictly scoped to this conversation and user
    const historyRows = await db
      .select({
        role: messages.role,
        content: messages.content,
      })
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.userId, user.id)))
      .orderBy(desc(messages.createdAt))
      .limit(this.historyLimit);
    // Newest N messages, restored to chronological order (asc + limit would keep the OLDEST N).
    historyRows.reverse();

    // 6. Build ChatMessage array (this path has no tools, so it must say so)
    const chatMessages: ChatMessage[] = [
      { role: 'system', content: `${SYSTEM_PROMPT}\n${buildCapabilityContext([])}` },
    ];

    for (const msg of historyRows) {
      if (msg.role === 'user') {
        chatMessages.push({ role: 'user', content: formatUserMessageForModel(msg.content) });
      } else if (msg.role === 'assistant') {
        chatMessages.push({ role: 'assistant', content: msg.content });
      }
    }

    // 7. Invoke AI Provider
    const aiProvider = getAiProvider();
    logger.debug({ userId: user.id, provider: aiProvider.name }, 'Invoking AI Provider');
    const aiResponse = await aiProvider.generateResponse(chatMessages);

    // 8. Persist assistant reply in database
    const assistantMessage: NewMessage = {
      conversationId: conversation.id,
      userId: user.id,
      role: 'assistant',
      content: aiResponse.content,
      status: 'completed',
      metadata: {
        model: aiResponse.model,
        usage: aiResponse.usage,
      },
    };
    await db.insert(messages).values(assistantMessage);

    return {
      replyText: aiResponse.content,
      isDuplicate: false,
      userId: user.id,
      conversationId: conversation.id,
    };
  }
}

let activeOrchestrator: AgentOrchestrator | null = null;

export function getAgentOrchestrator(): AgentOrchestrator {
  if (!activeOrchestrator) {
    activeOrchestrator = new AgentOrchestrator();
  }
  return activeOrchestrator;
}

export function setAgentOrchestratorForTesting(orchestrator: AgentOrchestrator | null): void {
  activeOrchestrator = orchestrator;
}
