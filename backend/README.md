# CloudPulse FinOps Agent — Backend

AI-powered agent that analyzes 42 AWS resources, kills waste automatically, and requires approval for downgrades.

## Quick Start (GitHub Codespaces)

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your keys (or leave defaults for dry_run demo)
npm start
```

## Results at a Glance

| Metric | Value |
|--------|-------|
| Total Resources | 42 |
| Monthly Spend | $7,172.23 |
| Identified Savings | $3,003.29 (41.87%) |
| Auto-Execute Savings | $553.98/mo (no permission) |
| Approval-Needed Savings | $2,449.31/mo |
| Critical Alerts | 3 (need upscale NOW) |

## Permission Model

**No Permission Needed (auto-kill):**
- `TERMINATE` zombie EC2 instances (3 found → $276.48/mo saved)
- `DELETE` unattached EBS volumes (3 found → $277.50/mo saved)

**Permission Required (approval queue):**
- All downsizing (EC2 + RDS)
- All migrations (gp2→gp3, io1→gp3)
- All upscaling (critical alerts)
- Schedule start/stop, spot conversion

## API Endpoints

### Dashboard
```
GET  /api/health              → Health check
GET  /api/kpis                → All KPIs (spend, waste, savings, by team/env)
GET  /api/resources           → All resources with analysis
GET  /api/resources/:id       → Single resource detail
GET  /api/recommendations     → Recommendations sorted by savings
```

### AI Agent (requires ANTHROPIC_API_KEY)
```
POST /api/analyze             → Claude AI analysis (body: { resource_id } or empty for all)
POST /api/analyze/chat        → Chat: { question: "which servers should I kill?" }
```

### Auto-Execute (no permission)
```
POST /api/actions/auto-execute   → Kills zombies + deletes unattached EBS
GET  /api/actions/log            → Execution history
```

### Approval Flow (permission required)
```
POST /api/actions/request        → Create approval requests (body: { resource_id } or empty)
GET  /api/approvals/pending      → View pending approvals
POST /api/approvals/:id/approve  → Approve (body: { approved_by: "name" })
POST /api/approvals/:id/reject   → Reject (body: { reason: "..." })
POST /api/actions/execute/:id    → Execute approved action on AWS
```

## Execution Modes

Set in `.env`:
- `EXECUTE_MODE=dry_run` — Logs what it WOULD do (default, safe)
- `EXECUTE_MODE=live` — Actually fires AWS API calls

## Frontend Integration

Your teammate's frontend should hit these endpoints:

1. **Dashboard page** → `GET /api/kpis` + `GET /api/resources`
2. **Kill button** → `POST /api/actions/auto-execute`
3. **Approval queue** → `GET /api/approvals/pending`
4. **Approve/Reject** → `POST /api/approvals/:id/approve`
5. **Execute** → `POST /api/actions/execute/:id`
6. **AI Chat** → `POST /api/analyze/chat`

## File Structure

```
backend/
├── server.js                    ← Express server, all routes mounted
├── package.json
├── .env.example
├── data/
│   └── dataset.json             ← Parsed from Excel (42 resources, 22 rules, pricing)
└── src/
    ├── data/loader.js           ← Reads dataset, normalizes types, pricing lookups
    ├── rules/engine.js          ← 21 rules (R01-R21) with permission model
    ├── kpi/calculator.js        ← Waste %, savings, by team/env/type, CPU efficiency
    ├── agent/claude.js          ← Anthropic API integration (single/multi/chat)
    ├── actions/
    │   ├── ec2.js               ← terminate, stop, start, modify instance type
    │   ├── ebs.js               ← delete, migrate type, resize
    │   └── rds.js               ← modify class, disable multi-az, migrate storage
    ├── approvals/store.js       ← In-memory approval queue
    └── routes/
        ├── resources.js
        ├── kpis.js
        ├── analyze.js
        ├── actions.js
        └── approvals.js
```
