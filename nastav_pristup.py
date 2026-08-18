#!/usr/bin/env python3
"""
Nastavení přístupu do kokpitu POUTNÍK.

Zeptá se na přístupový klíč z GitHubu, OVĚŘÍ ho (jestli vidí repozitář
poutnik-data a umí do něj zapisovat) a pak ho zašifruje heslem do config.js.
Klíč se nikam jinam neukládá a bez hesla se z config.js nedá přečíst.

Spuštění:
    python3 nastav_pristup.py            nastavit přístup
    python3 nastav_pristup.py --overit   jen otestovat klíč, nic nezapisovat
"""

import base64
import getpass
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    sys.exit("Chybí knihovna cryptography. Nainstaluj ji:  pip3 install cryptography")

ITERACE = 600_000
KOREN = Path(__file__).resolve().parent
CONFIG = KOREN / "config.js"
ZKUSEBNI_SOUBOR = "data/.overeni-pristupu"


def gh(cesta, klic, metoda="GET", telo=None):
    req = urllib.request.Request("https://api.github.com" + cesta, method=metoda)
    req.add_header("Authorization", "Bearer " + klic)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    data = None
    if telo is not None:
        data = json.dumps(telo).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data, timeout=25) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}
    except urllib.error.URLError as e:
        return 0, {"message": f"nedá se spojit s GitHubem ({e.reason})"}


def overit_klic(klic, owner, repo):
    print("  Ověřuji klíč…", end="", flush=True)
    stav, telo = gh(f"/repos/{owner}/{repo}", klic)
    if stav == 0:
        return telo.get("message", "GitHub neodpovídá.")
    if stav == 401:
        return ("Klíč je neplatný nebo vypršel.\n"
                "     Vyrob nový na github.com/settings/personal-access-tokens")
    if stav == 404:
        return (f"Klíč nevidí repozitář {owner}/{repo}.\n"
                "     Nejčastější příčina: špatně vyplněné jedno ze dvou polí klíče.\n"
                f"       Resource owner ...... musí být {owner}\n"
                f"       Repository access ... Only select repositories → {owner}/{repo}\n"
                "     Pozor: volba „Public repositories\" nestačí, repo je soukromé.")
    if stav != 200:
        return f"GitHub vrátil {stav}: {telo.get('message', '')}"
    prava = telo.get("permissions") or {}
    if not prava.get("push"):
        return ("Klíč umí data jen číst, ne zapisovat.\n"
                "     V nastavení klíče přepni Repository permissions → Contents\n"
                "     na „Read and write\".")
    stav, telo = gh(
        f"/repos/{owner}/{repo}/contents/{ZKUSEBNI_SOUBOR}", klic, "PUT",
        {"message": "Ověření přístupu", "content": base64.b64encode(b"ok").decode()},
    )
    if stav not in (200, 201):
        return ("Klíč repozitář vidí, ale zápis neprošel.\n"
                f"     GitHub vrátil {stav}: {telo.get('message', '')}\n"
                "     Zkontroluj Repository permissions → Contents = „Read and write\".")
    sha = (telo.get("content") or {}).get("sha")
    if sha:
        gh(f"/repos/{owner}/{repo}/contents/{ZKUSEBNI_SOUBOR}", klic, "DELETE",
           {"message": "Úklid po ověření", "sha": sha})
    print(" v pořádku, čte i zapisuje.")
    return None


def zasifruj(text, heslo):
    """sůl(16) + iv(12) + šifra — přesně jak to čte prohlížeč ve WebCrypto."""
    sul = os.urandom(16)
    iv = os.urandom(12)
    klic = hashlib.pbkdf2_hmac("sha256", heslo.encode("utf-8"), sul, ITERACE, 32)
    return base64.b64encode(sul + iv + AESGCM(klic).encrypt(iv, text.encode("utf-8"), None)).decode("ascii")


def nacti_nastaveni():
    text = CONFIG.read_text(encoding="utf-8")
    return json.loads(text[text.index("{"): text.rindex("}") + 1])


NAVOD = """
  Klíč vyrobíš tady (2 minuty, stejně jako u chundela-kokpitu):

    github.com/settings/personal-access-tokens/new

    Token name .......... kokpit-poutnik
    Resource owner ...... {owner}
    Expiration .......... No expiration  (nebo rok, pak se obnovuje)
    Repository access ... Only select repositories → {owner}/{repo}
    Permissions ......... Repository permissions → Contents → Read and write

  Pak Generate token a klíč zkopíruj (začíná github_pat_).
"""


def ziskej_klic(owner, repo):
    print(NAVOD.format(owner=owner, repo=repo))
    while True:
        klic = getpass.getpass("  Vlož klíč (nebude vidět): ").strip()
        if not klic:
            sys.exit("  Zrušeno.")
        if not klic.startswith(("github_pat_", "ghp_")):
            print("  To nevypadá jako klíč z GitHubu. Má začínat github_pat_ nebo ghp_.\n")
            continue
        potize = overit_klic(klic, owner, repo)
        if not potize:
            return klic
        print(f"\n  ✗ {potize}\n")
        if input("  Opravit v prohlížeči a zkusit znovu? [a/n] ").strip().lower() not in ("a", "ano", "y", ""):
            sys.exit("  Nastavení zrušeno, config.js zůstal beze změny.")
        print()


def main():
    nastaveni = nacti_nastaveni()
    owner, repo = nastaveni["owner"], nastaveni["repo"]
    jen_overit = "--overit" in sys.argv

    print("\n  NASTAVENÍ PŘÍSTUPU DO KOKPITU POUTNÍK")
    print("  " + "-" * 46)

    klic = ziskej_klic(owner, repo)
    if jen_overit:
        print("\n  Klíč je funkční. Nic jsem nezapisoval.\n")
        return

    print("\n  Teď heslo, kterým bude kokpit zamčený (pro tebe i parťáka stejné).")
    while True:
        heslo = getpass.getpass("  Heslo: ")
        if len(heslo) < 10:
            print("     Aspoň 10 znaků, prosím.")
            continue
        znovu = getpass.getpass("     Ještě jednou pro kontrolu: ")
        if heslo != znovu:
            print("     Hesla se neshodují, zkus to znovu.")
            continue
        break

    print("\n  Šifruji (chvilku to trvá, je to schválně pomalé)…")
    nastaveni["iterace"] = ITERACE
    nastaveni["blobs"] = {"spolecne": zasifruj(klic, heslo)}

    CONFIG.write_text(
        "/* Nastaveni kokpitu POUTNIK.\n"
        "   Blob je pristupovy klic k datum zasifrovany heslem - vygeneruje ho\n"
        "   `python3 nastav_pristup.py`. Bez hesla se z nej nic neprecte. */\n"
        "window.CFG = " + json.dumps(nastaveni, indent=2, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )
    print(f"  Hotovo, zapsáno do {CONFIG.name}.")

    if input("\n  Nasadit rovnou na web? [a/n] ").strip().lower() in ("a", "ano", "y", ""):
        subprocess.run(["bash", str(KOREN / "nasadit.sh"), "Nový přístupový klíč"], check=False)
    else:
        print("  Až budeš chtít, spusť:  ./nasadit.sh")


if __name__ == "__main__":
    main()
