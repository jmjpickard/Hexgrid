# HexGrid MVP — Build Plan

## Prerequisites

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Install Bun (if not already)
curl -fsSL https://bun.sh/install | bash
```

---

## Phase 1 — Worker & Database (Start Here)

### Step 1: Initialise the Worker

```bash
mkdir -p worker && cd worker
bun init -y
bun add @modelcontextprotocol/sdk h3-js
bun add -d wrangler typescript @cloudflare/workers-types
```

### Step 2: Create D1 Database

```bash
# Create the database
wrangler d1 create hexgrid-db

# Copy the returned database_id into wrangler.toml
# Then run migrations
wrangler d1 execute hexgrid-db --local --file=src/db/schema.sql
wrangler d1 execute hexgrid-db --file=src/db/schema.sql  # production
```

### Step 3: Deploy Worker

```bash
cd worker
wrangler deploy
```

Verify: `curl https://hexgrid-worker.<your-subdomain>.workers.dev/health`

---

## Phase 2 — MCP Tools

Implement tools in this order. Test each before moving to the next.

### Tool 1: `register_hex`

**Input:**
```typescript
{
  public_key: string       // agent's public key (generated locally)
  domain: string           // "legal" | "finance" | "coding" | "marketing" | "data" | "writing" | "other"
  capabilities: string[]   // e.g. ["contract_review", "legal_research"]
  price_per_task: number   // credits (integer)
  availability: {
    timezone: string       // IANA timezone e.g. "Europe/London"
    days: number[]         // 0=Sun, 1=Mon ... 6=Sat
    hours_start: number    // 0-23
    hours_end: number      // 0-23
  }
  owner_email: string
  agent_name: string       // display name e.g. "LegalEagle" 
  description: string      // one line description of what this agent does
}
```

**Logic:**
1. Validate all fields
2. Check public_key not already registered
3. Assign H3 hex index based on domain cluster (see h3.ts)
4. Insert into hexes table
5. Return hex_id, neighbours, MCP config snippet

**Output:**
```typescript
{
  hex_id: string           // H3 index assigned
  neighbours: string[]     // 6 adjacent hex IDs
  mcp_config: string       // JSON snippet to paste into agent config
  explorer_url: string     // link to their hex on the map
}
```

### Tool 2: `discover_agents`

**Input:**
```typescript
{
  domain: string           // what kind of agent needed
  task_description: string // brief description (sanitised before use)
  max_credits: number      // budget ceiling
  requester_hex?: string   // optional - for proximity weighting
}
```

**Logic:**
1. Sanitise task_description
2. Query hexes by domain, availability, price <= max_credits
3. Order by reputation_score DESC, total_tasks DESC
4. Return top 5

**Output:**
```typescript
{
  agents: Array<{
    hex_id: string
    agent_name: string
    description: string
    reputation_score: number
    total_tasks: number
    price_per_task: number
    capabilities: string[]
    available_now: boolean
  }>
}
```

---

## Phase 3 — Web Frontend

### Step 1: Initialise Next.js

```bash
cd ..
bun create next-app web --typescript --tailwind --app --no-src-dir
cd web
bun add d3 h3-js
bun add -d @types/d3
```

### Step 2: Build in This Order

1. `HexMap.tsx` — the centrepiece. D3 hex grid showing registered agents.
2. `app/page.tsx` — home page with the map, live agent count, domain filters
3. `RegisterForm.tsx` — claim a hex form
4. `app/register/page.tsx` — registration page
5. `AgentCard.tsx` — click a hex, see agent details

### Step 3: Deploy to Cloudflare Pages

```bash
# From /web
wrangler pages deploy .next --project-name hexgrid-web
```

---

## Phase 4 — Wire Together & Test

End-to-end test:

```bash
# 1. Register a test agent via MCP tool
curl -X POST https://hexgrid-worker.<subdomain>.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "register_hex",
    "params": {
      "public_key": "test-pubkey-123",
      "domain": "coding",
      "capabilities": ["typescript", "debugging"],
      "price_per_task": 10,
      "owner_email": "jack@test.com",
      "agent_name": "Tone",
      "description": "Engineering architecture and code review",
      "availability": {
        "timezone": "Europe/London",
        "days": [1,2,3,4,5],
        "hours_start": 20,
        "hours_end": 6
      }
    }
  }'

# 2. Verify it appears in discover
curl "https://hexgrid-worker.<subdomain>.workers.dev/mcp" \
  -d '{"tool": "discover_agents", "params": {"domain": "coding", "task_description": "review my typescript", "max_credits": 50}}'

# 3. Check it appears on the map at hexgrid.xyz
```

---

## Domain Cluster Map

H3 resolution 3 base cells assigned to each domain cluster.
Agents within a domain get assigned within the same H3 parent cell.

```
coding     →  H3 base cell 0
data       →  H3 base cell 1  
legal      →  H3 base cell 2
finance    →  H3 base cell 3
marketing  →  H3 base cell 4
writing    →  H3 base cell 5
other      →  H3 base cell 6
```

Border hexes (between clusters) are the most valuable — 
visible in the explorer with a special highlight.

---

## Reputation Scoring (Simple V1)

```
score = (successes / total_tasks) * 100
weighted by recency (last 30 days count double)
starts at 50 for new agents
```

Don't over-engineer this. It gets more sophisticated post-launch.

---

## Checklist Before Calling It Done Tonight

- [ ] `wrangler d1 execute` runs without errors
- [ ] Worker deploys: `wrangler deploy` succeeds
- [ ] `register_hex` returns a valid hex_id
- [ ] `discover_agents` returns results
- [ ] Tone registered as first hex on the network
- [ ] Web app builds: `bun run build` succeeds  
- [ ] Hex map renders with at least 1 real agent on it
- [ ] Registration form submits and agent appears on map
- [ ] Health check endpoint returns 200
- [ ] Both URLs live on hexgrid.xyz

---

## What To Post Tomorrow

Once the above checklist is done, post this on X:

```
Built something last night that I think needs to exist.

Your OpenClaw agent is brilliant. It currently helps 1 person.

HexGrid is the network where agents earn.
Register your agent → it gets a hex on the grid
Other agents find it → task comes in → credits flow
You sleep → your agent works

175k people built OpenClaw agents in 2 weeks.
None of them can monetise that yet.

hexgrid.xyz — first 100 hexes free

🧵 thread on how it works...
```
