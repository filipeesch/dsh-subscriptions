/**
 * Agent creation for one Cursor conversation: the SDK options, the tool seam,
 * and the guards that keep a late handle out of the registry.
 *
 * Creation is asynchronous while cancellation, supersession, and disposal are
 * not, so the caller hands in the three checks this module applies before it
 * publishes a session. The factory performs no registry work and holds the one
 * process-wide warmup.
 */

import { asObject, hash } from './prompt.js'
import type { CursorParam } from './catalog.js'
import { safeError } from './failure.js'
import {
  CursorSession,
  requestKeyOf,
  settle,
  signatureOf,
  type CursorAgent,
  type CursorGateway,
  type CursorRun,
} from './session.js'
import type { CursorTranscript } from './transcript.js'
import { TurnAborted } from './turn-gate.js'

/** What one agent creation needs from the turn that asked for it. */
export interface CreateAgentInput {
  /** Conversation key the agent serves. */
  key: string
  modelId: string
  params: CursorParam[] | undefined
  transcript: CursorTranscript
  apiKey: string
  /** Conversation the working directory belongs to. */
  sessionId: string | undefined
  signal?: AbortSignal
  /** Order this agent was created for; a newer turn supersedes it. */
  generation: number
  /** Whether the runtime was disposed while the SDK call was open. */
  disposed: () => boolean
  /** Whether the turn that asked for this agent still owns the conversation. */
  current: () => boolean
}

/** What the factory needs from the runtime. */
export interface AgentFactoryOptions {
  gateway: CursorGateway
  /** Working directory for agents of one conversation. */
  cwd: (sessionId: string | undefined) => string
  /** Whether the runtime has been disposed. */
  disposed: () => boolean
  /** Diagnostics sink for failures that are not the current request's. */
  onWarn?: (message: string) => void
}

/** Creates and warms Cursor agents for one runtime. */
export class AgentFactory {
  private warming: Promise<void> | undefined
  /** The warmup's one cleanup; the closure owns both handles it closes. */
  private prewarmCleanup: (() => Promise<void>) | undefined

  constructor(private readonly options: AgentFactoryOptions) {}

  /**
   * Create one agent and publish the session it serves.
   * @throws Error when the runtime was disposed, TurnAborted when the turn no
   *   longer owns the conversation or was cancelled.
   */
  async create(input: CreateAgentInput): Promise<CursorSession> {
    if (input.disposed()) throw new Error('Cursor runtime is disposed')
    const credentialId = hash(input.apiKey)
    const session = new CursorSession(
      input.key,
      signatureOf(input.modelId, input.params),
      input.params,
      input.modelId,
      credentialId,
      requestKeyOf(input.modelId, input.params, credentialId),
    )
    session.systemPrompt = input.transcript.systemPrompt
    const { local } = syncTools(session, input.transcript.tools)
    const agent = await this.options.gateway.createAgent({
      model: {
        id: input.modelId,
        ...(input.params?.length ? { params: input.params } : {}),
      },
      apiKey: input.apiKey,
      // Always "mcp": DSH tools are MCP custom tools, and tools can be added later.
      tools: ['mcp'],
      local: {
        cwd: this.options.cwd(input.sessionId),
        settingSources: [],
        ...(local?.customTools === undefined
          ? {}
          : { customTools: local.customTools }),
      },
    })
    // A cancelled or disposed turn must not publish a late agent into the
    // registry: it would close the session that replaced it.
    if (input.disposed()) {
      settle(() => agent.close?.())
      throw new Error('Cursor runtime is disposed')
    }
    if (input.signal?.aborted) {
      settle(() => agent.close?.())
      throw new TurnAborted()
    }
    if (!input.current()) {
      settle(() => agent.close?.())
      throw new TurnAborted()
    }
    session.agent = agent
    return session
  }

  /**
   * Pay the SDK's per-process setup in the background, once.
   *
   * A warmup that fails before its run exists clears the latch, so the next
   * live catalog read tries again instead of leaving warmup off for the life of
   * the process. A run this method cancels rejects its own wait; that is the
   * warmup's expected end and is not a failure.
   */
  prewarm(apiKey: string, modelId: string): void {
    if (this.options.disposed()) return
    this.warming ??= this.runPrewarm(apiKey, modelId).then(
      () => undefined,
      (error: unknown) => {
        this.warming = undefined
        this.options.onWarn?.(
          `Cursor prewarm failed: ${safeError(error, 'warm the SDK')}`,
        )
      },
    )
  }

  /** Close whatever the warmup still holds; called from the plugin's disposer. */
  async cleanup(): Promise<void> {
    await this.prewarmCleanup?.()
  }

  // Discarded state on dispose only; kept for one process in tests.
  private async runPrewarm(apiKey: string, modelId: string): Promise<void> {
    if (this.options.disposed()) return
    let agent: CursorAgent | undefined
    let run: CursorRun | undefined
    let cancelled = false
    let agentClosed = false
    // One cleanup path closes whatever handle exists by then, exactly once.
    const close = async (): Promise<void> => {
      if (run !== undefined && !cancelled) {
        cancelled = true
        await Promise.resolve(run.cancel?.()).catch(() => {})
      }
      if (agent !== undefined && !agentClosed) {
        agentClosed = true
        settle(() => agent?.close?.())
      }
    }
    this.prewarmCleanup = close
    try {
      const cwd = this.options.cwd(undefined)
      agent = await this.options.gateway.createAgent({
        model: { id: modelId },
        apiKey,
        tools: ['mcp'],
        local: { cwd, settingSources: [] },
      })
      if (this.options.disposed()) return
      run = await agent.send('.')
      if (this.options.disposed()) return
      cancelled = true
      await Promise.resolve(run.cancel?.()).catch(() => {})
      await Promise.resolve(run.wait?.()).catch(() => {})
      const id = agent.agentId
      if (id) {
        void this.options.gateway
          .deleteAgent?.(id, { apiKey, local: { cwd } })
          .catch(() => {})
      }
    } finally {
      this.prewarmCleanup = undefined
      await close()
    }
  }
}

/**
 * Point the session at the current tools; returns the send options that carry
 * them.
 */
export function syncTools(
  session: CursorSession,
  tools: CursorTranscript['tools'],
): { local?: { customTools?: Record<string, unknown> } } {
  session.toolsKey = toolsKeyOf(tools)
  session.toolNames = tools.map((tool) => tool?.name).filter(Boolean)
  const customTools: Record<string, unknown> = {}
  for (const tool of tools) {
    if (!tool?.name) continue
    customTools[tool.name] = {
      description: tool.description || tool.name,
      inputSchema:
        tool.parameters !== null && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
      execute: (args: unknown, context: unknown) =>
        session.registerCall(
          tool.name,
          args,
          asObject(context).toolCallId as string | undefined,
        ),
    }
  }
  return Object.keys(customTools).length > 0 ? { local: { customTools } } : {}
}

/** A fingerprint of the tool list, so a changed list is detectable. */
export function toolsKeyOf(
  tools: readonly {
    name?: string
    description?: string
    parameters?: unknown
  }[],
): string {
  return hash(
    JSON.stringify(
      tools.map((tool) => [
        tool?.name,
        tool?.description ?? '',
        tool?.parameters ?? {},
      ]),
    ),
  )
}

/**
 * Cursor lists the custom tools to the model when a conversation starts and
 * does not announce later ones, so an added tool needs a note.
 */
export function addedToolsNote(
  session: CursorSession,
  tools: CursorTranscript['tools'],
): string {
  const added = tools
    .map((tool) => tool?.name)
    .filter(
      (name): name is string =>
        Boolean(name) && !session.toolNames.includes(name!),
    )
  return added.length > 0
    ? `[Tool update: these tools were added and are now available: ${added.join(', ')}. Look up their schemas before calling them.]`
    : ''
}
