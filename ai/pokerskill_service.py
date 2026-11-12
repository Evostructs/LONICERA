import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ACTION_MAP = {
    "f": "fold",
    "fold": "fold",
    "k": "check",
    "check": "check",
    "c": "call",
    "call": "call",
    "b": "raise",
    "bet": "raise",
    "raise": "raise",
    "allin": "allin",
    "all-in": "allin",
    "all_in": "allin",
}


class ServiceError(Exception):
    pass


def bool_from_env(name, default=False):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def load_pokerskill(pokerskill_path):
    if pokerskill_path:
        resolved = Path(pokerskill_path).expanduser().resolve()
        sys.path.insert(0, str(resolved))

    from pokerskill_agent.schema import validate_game_state
    from pokerskill_agent._core import generate_prompt

    return validate_game_state, generate_prompt


def join_cards(cards):
    return "".join(cards or [])


def normalize_action(action):
    return ACTION_MAP.get(str(action or "").strip().lower())


def first_json_object(text):
    if not text:
        raise ServiceError("empty_model_response")

    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned, flags=re.IGNORECASE).strip()
        cleaned = re.sub(r"```$", "", cleaned).strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
    if not match:
        raise ServiceError("model_response_missing_json")
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise ServiceError(f"model_response_invalid_json:{exc.msg}") from exc


def build_state(payload):
    street = payload.get("street")
    if street not in {"preflop", "flop", "turn", "river"}:
        raise ServiceError("unsupported_street")

    legal_actions = payload.get("pokerSkillLegalActions") or []
    if not legal_actions:
        raise ServiceError("missing_legal_actions")

    state = {
        "hand_id": int(payload.get("handId") or 1),
        "street": street,
        "hero_hole_cards": join_cards(payload.get("heroHoleCards")),
        "board_cards": "" if street == "preflop" else join_cards(payload.get("boardCards")),
        "pot": float(payload.get("potBb") or 0),
        "total_pot": float(payload.get("totalPotBb") or payload.get("potBb") or 0),
        "hero_stack": float(payload.get("heroStackBb") or 0),
        "villain_stack": float(payload.get("villainStackBb") or 0),
        "hero_position": payload.get("heroPosition"),
        "legal_actions": legal_actions,
        "raise_min": payload.get("minRaiseToBb") if "b" in legal_actions else None,
        "raise_max": payload.get("maxRaiseToBb") if "b" in legal_actions else None,
        "action_history": payload.get("actionHistoryTokens") or [],
        "use_skills": True,
    }
    return state


def append_lonicera_context(user_prompt, payload):
    lines = payload.get("actionHistoryText") or []
    context = ""
    if lines:
        readable = "\n".join(f"- {line}" for line in lines)
        context = f"\n\n=== LONICERA ACTION HISTORY (authoritative) ===\n{readable}"

    return (
        f"{user_prompt}{context}\n\n"
        "Return only JSON for LONICERA: "
        '{"action":"fold|check|call|raise|allin","amountBb":number|null}. '
        'Use "raise" for any PokerSkill bet/raise action.'
    )


def dry_run_decision(payload):
    legal = set(payload.get("pokerSkillLegalActions") or [])
    if float(payload.get("toCallBb") or 0) > 0:
        if "c" in legal:
            return {"action": "call", "amountBb": None, "modelVersion": "pokerskill-dry-run"}
        return {"action": "fold", "amountBb": None, "modelVersion": "pokerskill-dry-run"}
    return {"action": "check", "amountBb": None, "modelVersion": "pokerskill-dry-run"}


def openai_compatible_completion(system_prompt, user_prompt, args):
    api_key = os.environ.get("POKERSKILL_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ServiceError("missing_openai_api_key")

    base_url = (args.openai_base_url or os.environ.get("POKERSKILL_OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
    model = args.model or os.environ.get("POKERSKILL_MODEL") or "gpt-4o"
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": float(os.environ.get("POKERSKILL_TEMPERATURE", "0.2")),
        "max_tokens": int(os.environ.get("POKERSKILL_MAX_TOKENS", "512")),
    }
    encoded = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=encoded,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=args.llm_timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ServiceError(f"llm_http_{exc.code}") from exc
    except urllib.error.URLError as exc:
        raise ServiceError("llm_request_failed") from exc

    content = data["choices"][0]["message"]["content"]
    parsed = first_json_object(content)
    action = normalize_action(parsed.get("action") or parsed.get("selectedAction"))
    if not action:
        raise ServiceError("model_selected_invalid_action")
    amount = parsed.get("amountBb", parsed.get("amount"))
    return {
        "action": action,
        "amountBb": amount,
        "modelVersion": model,
    }


class PokerSkillRuntime:
    def __init__(self, args):
        self.args = args
        self.validate_game_state, self.generate_prompt = load_pokerskill(args.pokerskill_path)

    def decide(self, payload):
        state = self.validate_game_state(build_state(payload))
        prompt = self.generate_prompt(state)
        user_prompt = append_lonicera_context(prompt["user_prompt"], payload)

        if self.args.dry_run:
            result = dry_run_decision(payload)
        else:
            result = openai_compatible_completion(prompt["system_prompt"], user_prompt, self.args)

        action = normalize_action(result.get("action"))
        if not action:
            raise ServiceError("invalid_decision_action")

        return {
            "ok": True,
            "action": action,
            "amountBb": result.get("amountBb"),
            "modelVersion": result.get("modelVersion") or "pokerskill",
        }


def make_handler(runtime):
    class Handler(BaseHTTPRequestHandler):
        def _send_json(self, status, payload):
            encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_POST(self):
            started = time.perf_counter()
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length > 0 else b"{}"
                payload = json.loads(raw.decode("utf-8"))

                if self.path == "/health":
                    self._send_json(
                        200,
                        {
                            "ok": True,
                            "status": "online",
                            "dryRun": runtime.args.dry_run,
                        },
                    )
                    return
                if self.path != "/decide":
                    self._send_json(404, {"ok": False, "error": "not_found"})
                    return

                response = runtime.decide(payload)
                response["latencyMs"] = round((time.perf_counter() - started) * 1000, 2)
                self._send_json(200, response)
            except ServiceError as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": type(exc).__name__})

        def log_message(self, format, *args):
            return

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pokerskill-path", default=os.environ.get("POKERSKILL_PATH", ""))
    parser.add_argument("--host", default=os.environ.get("POKERSKILL_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("POKERSKILL_PORT", "8910")))
    parser.add_argument("--model", default=os.environ.get("POKERSKILL_MODEL", ""))
    parser.add_argument("--openai-base-url", default=os.environ.get("POKERSKILL_OPENAI_BASE_URL", ""))
    parser.add_argument("--llm-timeout", type=float, default=float(os.environ.get("POKERSKILL_LLM_TIMEOUT", "30")))
    parser.add_argument("--dry-run", action="store_true", default=bool_from_env("POKERSKILL_DRY_RUN", False))
    args = parser.parse_args()

    runtime = PokerSkillRuntime(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(runtime))
    print(json.dumps({"ok": True, "host": args.host, "port": args.port, "dryRun": args.dry_run}))
    server.serve_forever()


if __name__ == "__main__":
    main()
