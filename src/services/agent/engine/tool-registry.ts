import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolSpec } from '../../ai/types';
import type { AnyToolDefinition, ToolDefinition } from './types';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

function stripUnsupportedKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupportedKeywords);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      // Zod validates server-side; providers differ on which of these they accept.
      if (key === '$schema' || key === 'additionalProperties') continue;
      out[key] = stripUnsupportedKeywords(value);
    }
    return out;
  }
  return node;
}

/** Whether `granted` satisfies `required`. Supports exact match and `namespace:*` wildcards. */
export function hasPermission(granted: ReadonlySet<string>, required: string): boolean {
  if (granted.has(required)) return true;
  const colon = required.indexOf(':');
  return colon > 0 && granted.has(`${required.slice(0, colon)}:*`);
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): this {
    if (!TOOL_NAME_PATTERN.test(definition.name)) {
      throw new Error(`Invalid tool name "${definition.name}": use snake_case, 3-64 chars`);
    }
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered`);
    }
    if (!definition.description.trim()) {
      throw new Error(`Tool "${definition.name}" requires a description`);
    }
    if (definition.permissions.length === 0) {
      throw new Error(`Tool "${definition.name}" must declare at least one required permission`);
    }
    if (definition.sideEffect === 'non_idempotent') {
      if (!definition.requiresConfirmation) {
        throw new Error(`Non-idempotent tool "${definition.name}" must require user confirmation`);
      }
      if (definition.retry.maxRetries !== 0) {
        throw new Error(`Non-idempotent tool "${definition.name}" must not be retried`);
      }
    }
    if (definition.timeoutMs <= 0 || definition.retry.maxRetries < 0 || definition.retry.backoffMs < 0) {
      throw new Error(`Tool "${definition.name}" has an invalid timeout or retry policy`);
    }
    this.tools.set(definition.name, definition as unknown as AnyToolDefinition);
    return this;
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Tool declarations to expose to the model: only tools the user is actually permitted to call. */
  specsFor(granted: ReadonlySet<string>): ToolSpec[] {
    return this.list()
      .filter((tool) => tool.permissions.every((p) => hasPermission(granted, p)))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: stripUnsupportedKeywords(
          zodToJsonSchema(tool.inputSchema, { target: 'openApi3', $refStrategy: 'none' })
        ) as Record<string, unknown>,
      }));
  }
}
