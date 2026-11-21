#!/usr/bin/env python3
"""在你自己的机器/VPS 上跑的抽节点脚本（这台沙箱机器验不了 SOCKS）。
用法：
  1. 把凭据文件 ~/.ur-credentials.json 拷到这台机器的相同位置，
     或者设环境变量 UR_API_KEY=<urn_ 开头的 key>；
  2. python3 draw_socks.py
流程：按速度取美国 provider -> 逐个钉死建代理 -> 直接用 SOCKS
（curl -x socks5h://token:@host:port）查 ip-api 验出口（双 false、
住宅 ISP、两次 IP 一致）-> 通过后实测 generate_204 / x.com / 测速 ->
把 V2rayN 明文链接存成 ur-node.txt。key 只在脚本里用，绝不打印。
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "https://api.bringyour.com"
LOCATION_ID = "018bab1d-60e8-27a7-3757-6b11fd7e747c"
IP_API = "http://ip-api.com/json/?fields=status,country,regionName,city,isp,org,as,proxy,hosting,query"
HOSTING_WORDS = ["amazon", "google cloud", "microsoft", "azure", "digitalocean",
                 "linode", "vultr", "ovh", "hetzner", "fastly", "cloudflare",
                 "akamai", "datacenter", "data center", "hosting", "server"]


def load_key():
    k = os.environ.get("UR_API_KEY")
    if k:
        return k.strip()
    for p in (os.path.expanduser("~/.ur-credentials.json"),
              os.path.expanduser("~/workspace/user/.ur-credentials.json")):
        if os.path.exists(p):
            with open(p) as f:
                return json.load(f)["api_key"]
    k = input("粘贴 API key（urn_ 开头）：").strip()
    path = os.path.expanduser("~/.ur-credentials.json")
    with open(path, "w") as f:
        json.dump({"api_key": k}, f)
    os.chmod(path, 0o600)
    return k


def api_post(path, body, token, timeout=30):
    req = urllib.request.Request(
        API + path, data=json.dumps(body).encode(), method="POST"
    )
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def split_url(url):
    _, rest = url.split("://", 1)
    if "@" in rest:
        _, hostport = rest.rsplit("@", 1)
    else:
        hostport = rest
    host, port = hostport.rsplit(":", 1)
    return host, port


def curl_socks(socks_url, url, timeout=25):
    try:
        out = subprocess.run(
            ["curl", "-sS", "--max-time", str(timeout), "-x", socks_url, url],
            capture_output=True, text=True, timeout=timeout + 10)
        return out.returncode, out.stdout or "", out.stderr or ""
    except Exception as e:
        return -1, "", repr(e)[:150]


def curl_socks_status(socks_url, url, timeout=25):
    try:
        out = subprocess.run(
            ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}",
             "--max-time", str(timeout), "-x", socks_url, url],
            capture_output=True, text=True, timeout=timeout + 10)
        return out.returncode, (out.stdout or "").strip(), out.stderr or ""
    except Exception as e:
        return -1, "", repr(e)[:150]


def curl_socks_dl(socks_url, url, timeout=30):
    """经 SOCKS 下载，返回 (rc, 下载字节数, 用时秒)。用 -o /dev/null
    -w %{size_download} 直接取字节数，不捕获正文，避免二进制解码问题，
    超时时也能看到部分下载量。"""
    try:
        t0 = time.time()
        out = subprocess.run(
            ["curl", "-sS", "-o", "/dev/null", "-w", "%{size_download}",
             "--max-time", str(timeout), "-x", socks_url, url],
            capture_output=True, text=True, timeout=timeout + 10)
        dt = time.time() - t0
        try:
            n = int((out.stdout or "0").strip())
        except ValueError:
            n = 0
        return out.returncode, n, dt
    except Exception:
        return -1, 0, 0.0


def main():
    key = load_key()
    status, prov = api_post(
        "/network/find-providers2",
        {"specs": [{"location_id": LOCATION_ID}], "count": 5}, key)
    providers = (prov.get("providers") or [])
    providers.sort(key=lambda p: p.get("estimated_bytes_per_second") or 0,
                   reverse=True)
    print("providers:", len(providers))
    tried = 0
    for p in providers:
        if tried >= 5:
            break
        tried += 1
        pid = p["client_id"]
        loc = (p.get("location") or {})
        print(f"--- try {tried}: {loc.get('city')}, {loc.get('region_code')} "
              f"speed={p.get('estimated_bytes_per_second')} ---")
        status, auth = api_post("/network/auth-client", {
            "proxy_config": {"initial_device_state": {"location": {"connect_location_id": {"client_id": pid}}}}
        }, key)
        if status != 200:
            print("auth-client FAILED", status)
            continue
        res = auth.get("proxy_config_result") or auth
        token = res.get("auth_token")
        client_id = res.get("client_id") or auth.get("client_id")
        socks_url_raw = (res.get("socks_proxy_url") or "").strip()
        if socks_url_raw:
            socks_host, socks_port = split_url(socks_url_raw)
        else:
            socks_host, socks_port = "crisp.bringyour.com", "7117"
        socks_url = f"socks5h://{token}:@{socks_host}:{socks_port}"
        print("client:", client_id, "| token len:", len(token or ""),
              "| socks:", socks_host, socks_port)
        time.sleep(3)
        rc1, out1, err1 = curl_socks(socks_url, IP_API)
        try:
            j1 = json.loads(out1) if rc1 == 0 else {}
        except Exception:
            j1 = {}
        if not j1 or j1.get("status") != "success":
            print("probe1 failed rc:", rc1, "out:", out1[:150], "err:", err1[:150])
            api_post("/network/remove-client", {"client_id": client_id}, key)
            time.sleep(12)
            continue
        time.sleep(5)
        rc2, out2, _ = curl_socks(socks_url, IP_API)
        try:
            j2 = json.loads(out2) if rc2 == 0 else {}
        except Exception:
            j2 = {}
        ip1, ip2 = j1.get("query"), j2.get("query")
        stable = (ip1 and ip1 == ip2)
        double_false = (j1.get("proxy") is False and j1.get("hosting") is False)
        isp = (j1.get("isp") or "") + " " + (j1.get("org") or "")
        hosting_hit = any(w in isp.lower() for w in HOSTING_WORDS)
        print(f"exit: {ip1} | {j1.get('city')}, {j1.get('regionName')} | "
              f"ISP: {j1.get('isp')} | org: {j1.get('org')} | {j1.get('as')} | "
              f"proxy={j1.get('proxy')} hosting={j1.get('hosting')} | "
              f"stable={stable} (probe2={ip2}) | hosting_word={hosting_hit}")
        if not (double_false and stable and not hosting_hit):
            print("REJECT")
            api_post("/network/remove-client", {"client_id": client_id}, key)
            time.sleep(12)
            continue
        print("*** CLEAN EXIT -- running real tests ***")
        rc_g, code_g, _ = curl_socks_status(socks_url, "https://www.google.com/generate_204")
        rc_x, code_x, _ = curl_socks_status(socks_url, "https://x.com/")
        # 测速：失败重试一次（单次下载卡住可能是瞬断），标准不变（>=400KB 才算过）
        nbytes, dt, speed = 0, 0.0, 0.0
        for attempt in (1, 2):
            rc_s, nbytes, dt = curl_socks_dl(
                socks_url, "https://speed.cloudflare.com/__down?bytes=500000", timeout=30)
            speed = (nbytes / dt / 1024) if dt > 0 else 0
            print(f"speed try{attempt}: {nbytes} bytes in {dt:.1f}s = {speed:.0f} KB/s (rc={rc_s})")
            if nbytes >= 400000:
                break
            if attempt == 1:
                time.sleep(5)
        print(f"generate_204: rc={rc_g} http={code_g} | x.com: rc={rc_x} http={code_x} | "
              f"download {nbytes} bytes in {dt:.1f}s = {speed:.0f} KB/s")
        if not (code_g == "204" and code_x == "200" and nbytes >= 400000):
            print("real tests FAILED -> reject")
            api_post("/network/remove-client", {"client_id": client_id}, key)
            time.sleep(12)
            continue
        city = (j1.get("city") or "Unknown").replace(" ", "")
        isp_short = (j1.get("isp") or "Unknown").replace(" ", "")
        link = (f"socks://{token}:@{socks_host}:{socks_port}"
                f"#URnetwork-US-{city}-{isp_short}-Clean")
        with open("ur-node.txt", "w") as f:
            f.write(link + "\n")
        with open("winner.json", "w") as f:
            json.dump({"provider_client_id": pid, "client_id": client_id,
                       "exit": j1, "probe2_ip": ip2,
                       "tests": {"generate_204": code_g, "x_com": code_x,
                                 "speed_kbps": round(speed, 1)}},
                      f, indent=2)
        print("WINNER! link saved to ur-node.txt")
        print(f"exit: {ip1} {j1.get('city')} {j1.get('isp')} "
              f"proxy={j1.get('proxy')} hosting={j1.get('hosting')}")
        return 0
    print("no winner in", tried, "tries")
    return 1


if __name__ == "__main__":
    sys.exit(main())
