# Diagrams

Authored in Docent as tiered scenes; the
`.excalidraw` files beside this page are the sources and the Docent project
`sayagain` opens them at `docs/diagrams/<name>`. The Mermaid below is
Docent's export, kept here so the pictures render on GitHub and diff in pull
requests. When a diagram and a document disagree, the ADR wins and the
diagram gets fixed.

| Scene | Answers | Genre |
| ----- | ------- | ----- |
| `architecture` | Who talks to whom, and what happens to one call inside the boundary (dive into *Boundary pipeline*). Six call stories are declared as scenarios: WILCO, STANDBY twice, CORRECTION, UNABLE, DISREGARD. | Architecture map |
| `onboarding` | How a server gets behind the boundary and how a host finds it, without losing the server's name. ADR-0006. | Data flow |
| `learning-loop` | How ledger rows become signatures, rankings and measured interventions. ADR-0007. | Data flow |
| `packages` | What exists in the monorepo today and what is planned, with the links between them. `createProxy()` links to the pipeline internals in `architecture`. | Architecture map |

## architecture

```mermaid
flowchart LR
  %% genre (declared): Architecture map
  %% scenario: WILCO, a read-only call. Receipt, classify, no duplicate, no hold, forwarded unchanged, upstream succeeds, answered with a receipt and status executed.
  %%   Intake → Classifier → Dedupe → Policy gate → Forwarder → Verifier → Responder
  %% scenario: STANDBY, a destructive call held. The agent gets a held notice with the receipt; an operator approves; only then is it forwarded and executed once.
  %%   Intake → Classifier → Dedupe → Policy gate → Hold → Responder (held notice); Hold → Forwarder → Verifier → Responder
  %% scenario: STANDBY, a write failed with unknown outcome. Not provably idempotent, so held instead of retried. Nobody double-fires.
  %%   Intake → Classifier → Dedupe → Policy gate → Forwarder → Verifier → Hold → Responder
  %% scenario: CORRECTION, a coercible error repaired. A deterministic rule fixes the argument, recorded in _meta, forwarded again without a model round trip.
  %%   Intake → Classifier → Dedupe → Policy gate → Forwarder → Verifier → Repair → Forwarder → Verifier → Responder
  %% scenario: UNABLE, repair budget exhausted. Dead-lettered with intent attached; the agent is told UNABLE rather than left to loop.
  %%   Intake → Classifier → Dedupe → Policy gate → Forwarder → Verifier → Repair → Dead-letter → Responder
  %% scenario: DISREGARD, a duplicate call. Same key or same tool and arguments inside the window; nothing forwarded, the first result reproduced.
  %%   Intake → Classifier → Dedupe → Responder
  subgraph hosts["01 Agent hosts"]
    sdk["Custom agent with @sayagain/sdk"]
    cc["Claude Code"]
    ide["Cursor, Desktop, VS Code"]
  end
  subgraph daemon["02 Say Again daemon"]
    pipe["Boundary pipeline"]
    otel["Telemetry export"]
    learn["Learning loop"]
    dlq["Dead-letter queue"]
    routes["Virtual servers"]
    ledger["Ledger"]
    policy["Policy engine"]
  end
  subgraph upstream["03 Upstream MCP servers"]
    notion["Notion MCP"]
    github["GitHub MCP"]
  end
  subgraph ops["04 Operator surfaces"]
    backend["Observability backend"]
    cli["sayagain CLI"]
    operator(["Operator"])
  end
  subgraph internals["Boundary pipeline — internals"]
    intake["Intake"]
    forward["Forwarder"]
    verify["Verifier"]
    gate["Policy gate"]
    repair["Repair"]
    classify["Classifier"]
    respond["Responder"]
    hold["Hold"]
    dedupe["Dedupe"]
    dead["Dead-letter"]
  end
  cc -->|"tools/call"| routes
  ide -->|"tools/call"| routes
  sdk -->|"tools/call + intent"| routes
  routes -->|"receipt issued"| pipe
  pipe -->|"classify, may hold?"| policy
  pipe -->|"forward unchanged"| notion
  pipe -->|"forward unchanged"| github
  pipe -->|"record"| ledger
  pipe -->|"UNABLE"| dlq
  ledger -->|"signatures, shapes"| learn
  learn -->|"learned coercions"| policy
  learn -->|"augment tools/list"| routes
  ledger -->|"spans"| otel
  otel -->|"OTLP"| backend
  operator -->|"approve, replay"| cli
  cli -->|"replay with intent"| dlq
  cli -->|"tool-health report"| ledger
  intake -->|"tool, args, _meta"| classify
  classify -->|"with class"| dedupe
  dedupe -->|"new call"| gate
  dedupe -->|"DISREGARD"| respond
  gate -->|"clear"| forward
  gate -->|"STANDBY"| hold
  hold -->|"approved"| forward
  hold -->|"held notice"| respond
  forward -->|"upstream result"| verify
  verify -->|"WILCO"| respond
  verify -->|"coercible error"| repair
  verify -->|"write failed"| hold
  repair -->|"CORRECTION"| forward
  repair -->|"budget exhausted"| dead
  dead -->|"UNABLE"| respond
```

## onboarding

```mermaid
flowchart LR
  %% genre (declared): Data flow
  subgraph try["00 Try it"]
    wrapped["Wrapped server"]
    cmd["Server command"]
    sqlite["SQLite ledger"]
    wrap["sayagain wrap"]
  end
  subgraph adopt["01 Adopt"]
    backup["Backup"]
    restored["Host config, restored"]
    registry["~/.sayagain/config.json"]
    hostcfg["Host config file"]
    rewritten["Host config, rewritten"]
    eject["sayagain eject"]
    import["sayagain import --rewrite"]
  end
  subgraph run["02 Run"]
    host["Agent host"]
    upstreams["Upstream servers"]
    shim["sayagain stdio &lt;name&gt;"]
    daemon["Daemon"]
  end
  cmd -->|"argv"| wrap
  wrap -->|"stdio, unchanged"| wrapped
  wrap -->|"receipts, results"| sqlite
  hostcfg -->|"mcpServers entries"| import
  import -->|"original file"| backup
  import -->|"registrations"| registry
  import -->|"boundary entries"| rewritten
  backup -->|"original file"| eject
  eject -->|"direct entries"| restored
  rewritten -->|"read at startup"| host
  host -->|"spawn, JSON-RPC lines"| shim
  host -->|"HTTP /mcp/&lt;name&gt;"| daemon
  shim -->|"forwarded lines"| daemon
  registry -->|"routes, commands, env refs"| daemon
  daemon -->|"tools/call unchanged"| upstreams
```

## learning-loop

```mermaid
flowchart LR
  %% genre (declared): Data flow
  subgraph observe["01 Observe"]
    enrich["Enrich at recovery"]
    spans["Span export"]
    telemetry["Argument-free telemetry"]
    rows["Ledger rows"]
    backend["Observability backend"]
  end
  subgraph collate["02 Collate"]
    report["Tool-health report"]
    mask["Signature masker"]
    rank["Ranking"]
    groups["Signature groups"]
  end
  subgraph intervene["03 Intervene and measure"]
    picker["Intervention picker"]
    registry["Interventions registry"]
    lift["Lift measurement"]
    upstream["Upstream report"]
    next["Next call through the proxy"]
  end
  rows -->|"failure rows"| enrich
  rows -->|"call rows"| spans
  enrich -->|"turns, path, shape"| spans
  spans -->|"OTLP spans"| backend
  spans -->|"classes, outcomes"| telemetry
  enrich -->|"error text, shapes"| mask
  mask -->|"server, tool, signature"| groups
  groups -->|"counts, turns, waste"| rank
  rank -->|"ranked tools"| report
  rank -->|"top signatures"| picker
  picker -->|"one intervention per tool"| registry
  picker -->|"tool definition report"| upstream
  registry -->|"applied per tool"| next
  rows -->|"rows after the change"| lift
  lift -->|"keep or revert"| registry
```

## packages

```mermaid
flowchart LR
  %% genre (declared): Architecture map
  subgraph sdk["01 @sayagain/sdk"]
    strip["stripShim()"]
    classify["classify()"]
    meta["META keys and prowords"]
    withintent["withIntent(), buildMeta()"]
  end
  subgraph proxy["02 @sayagain/proxy"]
    cli["sayagain CLI"]
    transports["Transports"]
    create["createProxy()"]
    ledger["Ledger adapters"]
  end
  subgraph lint["03 @sayagain/lint"]
    linttool["lintTool(), grade()"]
    lintcli["CLI and GitHub Action"]
    rules["RULES catalogue"]
  end
  subgraph baseline["04 scripts/baseline"]
    tap["mcp-tap.mjs"]
    analyzer["claude-code-baseline.mjs"]
  end
  subgraph docs["05 spec and decisions"]
    measure["docs/measurement.md"]
    adrs["ADR-0001 to 0007"]
    spec["spec/intent-metadata.md"]
  end
  tap -->|"tap logs"| analyzer
  cli -->|"starts"| create
  adrs -->|"constrain"| create
  linttool -->|"reads"| rules
  analyzer -->|"produces M1 to M20"| measure
  cli -->|"configures"| transports
  lintcli -->|"calls"| linttool
  create -->|"writes receipts"| ledger
  transports -->|"applies shim inverse"| strip
  create -->|"imports"| classify
  create -->|"imports"| meta
  spec -->|"defines"| meta
```
