"""
CloudPulse FinOps — Streamlit dashboard for the Node backend.

Run backend: cd backend && npm start
Run UI:      cd frontend && pip install -r requirements.txt && streamlit run app.py
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import pandas as pd
import requests
import streamlit as st

DEFAULT_API_BASE = os.environ.get("FINOPS_API_URL", "http://127.0.0.1:3000").rstrip("/")


def api_get(base: str, path: str) -> tuple[int, Any]:
    url = f"{base}{path}"
    r = requests.get(url, timeout=30)
    try:
        data = r.json()
    except ValueError:
        data = r.text
    return r.status_code, data


def api_post(base: str, path: str, json_body: dict | None = None) -> tuple[int, Any]:
    url = f"{base}{path}"
    r = requests.post(url, json=json_body or {}, timeout=120)
    try:
        data = r.json()
    except ValueError:
        data = r.text
    return r.status_code, data


def init_state() -> None:
    if "api_base" not in st.session_state:
        st.session_state.api_base = DEFAULT_API_BASE


def resources_to_df(payload: dict) -> pd.DataFrame:
    rows = []
    for item in payload.get("resources", []):
        a = item.get("analysis") or {}
        rows.append(
            {
                "id": item.get("resource_id"),
                "name": item.get("name"),
                "type": item.get("resource_type"),
                "env": item.get("environment"),
                "team": item.get("team"),
                "monthly_$": item.get("monthly_cost_usd"),
                "status": a.get("status"),
                "savings_$": a.get("estimated_savings"),
                "action": a.get("primary_action"),
                "permission": a.get("permission"),
            }
        )
    return pd.DataFrame(rows)


def main() -> None:
    st.set_page_config(page_title="CloudPulse FinOps", layout="wide")
    init_state()

    st.title("CloudPulse FinOps")
    st.caption("Dashboard for the FinOps backend — spend, waste, approvals, and AI chat.")

    with st.sidebar:
        st.session_state.api_base = st.text_input(
            "API base URL",
            value=st.session_state.api_base,
            help="Backend root, e.g. http://127.0.0.1:3000",
        )
        base = st.session_state.api_base.rstrip("/")
        if st.button("Refresh data", use_container_width=True):
            st.rerun()

    try:
        h_code, health = api_get(base, "/api/health")
    except requests.RequestException as e:
        st.error(f"Cannot reach API at `{base}`: {e}")
        st.info("Start the backend with `cd backend && npm start`, then refresh.")
        return

    if h_code != 200:
        st.error(f"Health check failed ({h_code}): {health}")
        return

    mode = health.get("execution_mode", "?") if isinstance(health, dict) else "?"
    st.success(f"API online — execution mode: **{mode}**")

    tab_overview, tab_res, tab_rec, tab_act, tab_appr, tab_chat = st.tabs(
        ["Overview", "Resources", "Recommendations", "Actions", "Approvals", "AI chat"]
    )

    with tab_overview:
        k_code, kpis = api_get(base, "/api/kpis")
        if k_code != 200:
            st.error(kpis)
        else:
            s = kpis.get("summary", {})
            c1, c2, c3, c4, c5 = st.columns(5)
            c1.metric("Resources", s.get("total_resources", "—"))
            c2.metric("Monthly spend", f"${s.get('total_monthly_spend', 0):,.2f}")
            c3.metric("Identified savings", f"${s.get('total_identified_savings', 0):,.2f}")
            c4.metric("Auto-exec savings", f"${s.get('auto_execute_savings', 0):,.2f}")
            c5.metric("Needs approval", f"${s.get('approval_needed_savings', 0):,.2f}")

            st.metric("Waste vs spend", f"{s.get('waste_percentage', 0)}%")
            sc = s.get("status_counts") or {}
            st.subheader("Status mix")
            st.bar_chart(
                pd.DataFrame(
                    [{"status": k, "count": v} for k, v in sc.items() if v],
                ).set_index("status")
            )

            col_a, col_b = st.columns(2)
            with col_a:
                st.subheader("Quick wins")
                qw = kpis.get("quick_wins") or []
                st.dataframe(pd.DataFrame(qw), use_container_width=True, hide_index=True)
            with col_b:
                st.subheader("Critical alerts (upscale)")
                ca = kpis.get("critical_alerts") or []
                st.dataframe(pd.DataFrame(ca), use_container_width=True, hide_index=True)

            with st.expander("By type / team / environment"):
                bt = kpis.get("by_type") or {}
                if bt:
                    st.write("**By resource type**")
                    st.dataframe(
                        pd.DataFrame(
                            [
                                {"type": k, **{kk: vv for kk, vv in v.items()}}
                                for k, v in bt.items()
                            ]
                        ),
                        use_container_width=True,
                    )
                bteam = kpis.get("by_team") or {}
                if bteam:
                    st.write("**By team**")
                    st.dataframe(
                        pd.DataFrame(
                            [{"team": k, **v} for k, v in bteam.items()]
                        ),
                        use_container_width=True,
                    )
                benv = kpis.get("by_environment") or {}
                if benv:
                    st.write("**By environment**")
                    st.dataframe(
                        pd.DataFrame(
                            [{"environment": k, **v} for k, v in benv.items()]
                        ),
                        use_container_width=True,
                    )

    with tab_res:
        f1, f2, f3 = st.columns(3)
        r_type = f1.text_input("Filter type (e.g. EC2)", "")
        r_env = f2.text_input("Filter environment", "")
        r_stat = f3.selectbox("Status", ["", "critical", "warning", "info", "healthy"])

        qs = []
        if r_type.strip():
            qs.append(f"type={quote(r_type.strip())}")
        if r_env.strip():
            qs.append(f"environment={quote(r_env.strip())}")
        if r_stat:
            qs.append(f"status={r_stat}")
        path = "/api/resources" + ("?" + "&".join(qs) if qs else "")

        rc, data = api_get(base, path)
        if rc != 200:
            st.error(data)
        else:
            df = resources_to_df(data if isinstance(data, dict) else {})
            st.write(f"**{data.get('total', len(df))}** resources")
            st.dataframe(df, use_container_width=True, hide_index=True)

            detail_id = st.text_input("Resource ID for detail", "")
            if detail_id.strip():
                d_code, detail = api_get(base, f"/api/resources/{detail_id.strip()}")
                if d_code != 200:
                    st.error(detail)
                else:
                    st.json(detail)

    with tab_rec:
        # Mounted analyze router: GET /api/analyze/recommendations
        rr_code, rec = api_get(base, "/api/analyze/recommendations")
        if rr_code != 200:
            st.error(rec)
        else:
            st.write(
                f"**{rec.get('total_recommendations', 0)}** recommendations · "
                f"**${rec.get('total_monthly_savings', 0):,.2f}**/mo potential"
            )
            recs = rec.get("recommendations") or []
            rows = []
            for a in recs:
                rows.append(
                    {
                        "id": a.get("resource_id"),
                        "name": a.get("name"),
                        "type": a.get("resource_type"),
                        "action": a.get("primary_action"),
                        "savings": a.get("estimated_savings"),
                        "permission": a.get("permission"),
                        "details": (a.get("action_details") or "")[:120],
                    }
                )
            st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)

    with tab_act:
        st.warning("Auto-execute terminates zombie EC2 and deletes unattached EBS (per backend rules).")
        if st.button("Run auto-execute", type="primary"):
            ac, body = api_post(base, "/api/actions/auto-execute")
            if ac != 200:
                st.error(body)
            else:
                st.success(
                    f"Actions: **{body.get('actions_taken', 0)}** · "
                    f"Mode: **{body.get('mode')}** · "
                    f"Savings: **${body.get('total_monthly_savings', 0):,.2f}**/mo"
                )
                st.json(body)

        st.divider()
        if st.button("Queue approval requests (all that need approval)"):
            ac, body = api_post(base, "/api/actions/request", {})
            if ac != 200:
                st.error(body)
            else:
                st.success(f"Created **{body.get('approvals_created', 0)}** approval(s)")
                st.json(body)

        st.subheader("Execution log")
        lc, log_body = api_get(base, "/api/actions/log")
        if lc != 200:
            st.error(log_body)
        else:
            entries = log_body.get("log") or []
            st.dataframe(pd.DataFrame(entries), use_container_width=True, hide_index=True)

    with tab_appr:
        pc, pending = api_get(base, "/api/approvals/pending")
        if pc != 200:
            st.error(pending)
        else:
            st.write(
                f"**{pending.get('total_pending', 0)}** pending · "
                f"**${pending.get('total_savings_waiting', 0):,.2f}**/mo waiting"
            )
            appr = pending.get("approvals") or []
            st.dataframe(pd.DataFrame(appr), use_container_width=True, hide_index=True)

        st.subheader("Approve / reject / execute")
        c1, c2, c3 = st.columns(3)
        aid = c1.text_input("Approval ID (UUID)", "")
        approver = c2.text_input("Your name (approver)", value="streamlit")
        reason = c3.text_input("Rejection reason (if rejecting)", "")

        b1, b2, b3 = st.columns(3)
        if b1.button("Approve") and aid.strip():
            ec, eb = api_post(base, f"/api/approvals/{aid.strip()}/approve", {"approved_by": approver})
            st.json({"status": ec, "body": eb})
        if b2.button("Reject") and aid.strip():
            ec, eb = api_post(
                base,
                f"/api/approvals/{aid.strip()}/reject",
                {"rejected_by": approver, "reason": reason or "rejected via UI"},
            )
            st.json({"status": ec, "body": eb})
        if b3.button("Execute approved") and aid.strip():
            ec, eb = api_post(base, f"/api/actions/execute/{aid.strip()}", {})
            st.json({"status": ec, "body": eb})

    with tab_chat:
        st.caption("Uses `POST /api/analyze/chat` — requires `ANTHROPIC_API_KEY` on the backend.")
        q = st.text_area("Question", placeholder="Which resources should we downsize first?")
        if st.button("Ask", type="primary") and q.strip():
            cc, chat = api_post(base, "/api/analyze/chat", {"question": q.strip()})
            if cc != 200:
                st.error(chat)
            else:
                st.markdown("**Answer**")
                resp = chat.get("response") if isinstance(chat, dict) else chat
                st.write(resp)


if __name__ == "__main__":
    main()
