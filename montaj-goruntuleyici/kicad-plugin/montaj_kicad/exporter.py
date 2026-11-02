# -*- coding: utf-8 -*-
"""Montaj Görüntüleyici – KiCad export pipeline (no wx / pcbnew imports here).

Exports IPC-2581, BOM and STEP with kicad-cli into <project>/docs/montaj/kicad-export,
writes a job file and starts the assembly application with it.  The flags passed to
kicad-cli are taken from its own --help output, so KiCad 8, 9 and 10 all work.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

VERSION = "7.1.0"
IS_WIN = sys.platform.startswith("win")
NO_WINDOW = 0x08000000 if IS_WIN else 0          # CREATE_NO_WINDOW
DETACHED = 0x00000008 | 0x00000200 if IS_WIN else 0  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP

# Field names people use for manufacturer / part number (first existing one wins)
MFG_FIELDS = ["Manufacturer", "MANUFACTURER", "Mfr", "MFR", "Manufacturer_Name", "Üretici"]
MPN_FIELDS = ["MPN", "Manufacturer Part Number", "Manufacturer_Part_Number", "MFR_PN", "Mfr. Part #",
              "Mfr Part Number", "Part Number", "PartNumber", "Üretici Parça No"]


class ExportError(Exception):
    pass


# --------------------------------------------------------------------- paths
def plugin_dir():
    return os.path.dirname(os.path.abspath(__file__))


def load_config():
    cfg = {"export_step": True}
    for p in (os.path.join(plugin_dir(), "montaj_kicad.json"),):
        try:
            with open(p, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
        except (OSError, ValueError):
            pass
    return cfg


def find_kicad_cli(cfg=None):
    cfg = cfg or {}
    exe = "kicad-cli.exe" if IS_WIN else "kicad-cli"
    cands = [cfg.get("kicad_cli"), os.environ.get("KICAD_CLI")]
    # next to the running KiCad (sys.executable is KiCad's python / kicad.exe)
    for base in (os.path.dirname(sys.executable), os.path.dirname(os.path.dirname(sys.executable))):
        cands.append(os.path.join(base, exe))
        cands.append(os.path.join(base, "bin", exe))
    if IS_WIN:
        pf = os.environ.get("ProgramFiles", r"C:\Program Files")
        for v in ("10.0", "9.0", "8.0"):
            cands.append(os.path.join(pf, "KiCad", v, "bin", exe))
    elif sys.platform == "darwin":
        cands.append("/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli")
    cands.append(shutil.which("kicad-cli"))
    for c in cands:
        if c and os.path.isfile(c):
            return c
    raise ExportError("kicad-cli bulunamadı / kicad-cli not found")


def find_app(cfg=None):
    cfg = cfg or {}
    cands = [cfg.get("app_path"), os.environ.get("MONTAJ_APP")]
    app = os.path.join(plugin_dir(), "app")
    if IS_WIN:
        cands += [os.path.join(app, "Montaj Görüntüleyici.exe"), os.path.join(app, "MontajGoruntuleyici.exe")]
    elif sys.platform == "darwin":
        cands += [os.path.join(app, "Montaj Görüntüleyici.app", "Contents", "MacOS", "Montaj Görüntüleyici")]
    else:
        cands += [os.path.join(app, "montaj-gorunteleyici")]
    if os.path.isdir(app):
        for f in os.listdir(app):
            if f.lower().endswith(".exe") and "montaj" in f.lower():
                cands.append(os.path.join(app, f))
    for c in cands:
        if c and os.path.isfile(c):
            return c
    raise ExportError("Montaj Görüntüleyici uygulaması bulunamadı / assembly application not found: " + app)


# ------------------------------------------------------------- kicad-cli help
def run(cmd, timeout=900, cancel=None, tick=None):
    """Run a command, return (code, stdout+stderr). tick() is called while it runs."""
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=NO_WINDOW)
    t0 = time.time()
    out = []
    while True:
        try:
            o, _ = p.communicate(timeout=0.15)
            out.append(o)
            break
        except subprocess.TimeoutExpired:
            if tick:
                tick()
            if (cancel and cancel()) or time.time() - t0 > timeout:
                p.kill()
                raise ExportError("İptal edildi / cancelled" if cancel and cancel() else "Zaman aşımı / timeout: " + " ".join(cmd[:4]))
    return p.returncode, decode_output(b"".join(x for x in out if x))


def decode_output(raw):
    """kicad-cli writes through the Windows console code page, not UTF-8 (Türkçe yollar)."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    for enc in (("mbcs", "oem") if IS_WIN else ()) + ("cp1254", "cp857"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("latin-1")


def fresh_output(path, t0):
    """kicad-cli may exit non-zero although the file was written (e.g. STEP with VRML-only
    models). Success = a non-empty file written by this run."""
    try:
        st = os.stat(path)
        return st.st_size > 0 and st.st_mtime >= t0 - 2
    except OSError:
        return False


def remove_quiet(path):
    try:
        os.remove(path)
    except OSError:
        pass


def step_notes(txt, lang):
    """Turn kicad-cli STEP messages into short, readable notes."""
    notes = []
    vrml = len(re.findall(r"VRML", txt))
    if vrml:
        notes.append("STEP: bazı bileşenlerin yalnızca VRML (.wrl) 3D modeli var; bunlar STEP'e eklenemez, 3D görünümde kutu olarak gösterilir."
                     if lang == "tr" else
                     "STEP: some components only have VRML (.wrl) 3D models; they cannot go into STEP and are shown as boxes in the 3D view.")
    missing = sorted(set(re.findall(r"(?:No model defined for|Could not (?:load|find)[^:]*:?)\s*([^\s.,]+)", txt)))
    if missing:
        notes.append(("STEP: modeli bulunamayan: " if lang == "tr" else "STEP: models not found: ") + ", ".join(missing[:15]) + (" …" if len(missing) > 15 else ""))
    return notes


_help_cache = {}


def cli_flags(cli, *sub):
    key = (cli,) + sub
    if key not in _help_cache:
        try:
            _, txt = run([cli] + list(sub) + ["--help"], timeout=60)
        except (OSError, ExportError):
            txt = ""
        _help_cache[key] = txt
    return _help_cache[key]


def has_flag(help_text, flag):
    return re.search(r"(^|[\s,\[])" + re.escape(flag) + r"([\s,=\]]|$)", help_text, re.M) is not None


# ----------------------------------------------------------- schematic fields
def schematic_field_names(sch_path):
    """All symbol property names used in the schematic hierarchy."""
    names, seen, todo = set(), set(), [sch_path]
    while todo:
        p = todo.pop()
        if p in seen or not os.path.isfile(p):
            continue
        seen.add(p)
        try:
            with open(p, "r", encoding="utf-8") as f:
                txt = f.read()
        except OSError:
            continue
        names.update(re.findall(r'\(property\s+"([^"]+)"', txt))
        for sub in re.findall(r'\(property\s+"Sheet ?[Ff]ile(?:name)?"\s+"([^"]+)"', txt):
            todo.append(os.path.join(os.path.dirname(p), sub))
    return names


def pick_field(names, prefs):
    low = {n.lower(): n for n in names}
    for p in prefs:
        if p.lower() in low:
            return low[p.lower()]
    return None


# --------------------------------------------------------------- commands
def ipc2581_cmd(cli, board, out, mfg, mpn):
    h = cli_flags(cli, "pcb", "export", "ipc2581")
    if not h or "ipc2581" not in h.lower():
        raise ExportError("Bu kicad-cli IPC-2581 dışa aktarmayı desteklemiyor (KiCad 8+ gerekir) / kicad-cli has no IPC-2581 export (KiCad 8+ required)")
    cmd = [cli, "pcb", "export", "ipc2581", "-o", out]
    if has_flag(h, "--units"):
        cmd += ["--units", "mm"]
    if has_flag(h, "--precision"):
        cmd += ["--precision", "6"]
    if mpn and has_flag(h, "--bom-col-mfg-pn"):
        cmd += ["--bom-col-mfg-pn", mpn]
    if mfg and has_flag(h, "--bom-col-mfg"):
        cmd += ["--bom-col-mfg", mfg]
    return cmd + [board]


def bom_cmd(cli, sch, out, mfg, mpn, desc):
    h = cli_flags(cli, "sch", "export", "bom")
    if not h or "--fields" not in h:
        return None
    qty = "${QUANTITY}" if "${QUANTITY}" in h else "QUANTITY"
    fields, labels = ["Reference", "Value", "Footprint", qty], ["Reference", "Value", "Footprint", "Qty"]
    if desc:
        fields.append(desc); labels.append("Description")
    if mfg:
        fields.append(mfg); labels.append("Manufacturer")
    if mpn:
        fields.append(mpn); labels.append("MPN")
    group = ["Value", "Footprint"] + ([mpn] if mpn else [])
    cmd = [cli, "sch", "export", "bom", "-o", out, "--fields", ",".join(fields), "--labels", ",".join(labels)]
    if has_flag(h, "--group-by"):
        cmd += ["--group-by", ",".join(group)]
    if has_flag(h, "--ref-range-delimiter"):
        cmd += ["--ref-range-delimiter", ""]
    if has_flag(h, "--exclude-dnp"):
        cmd += ["--exclude-dnp"]
    return cmd + [sch]


def step_cmd(cli, board, out):
    h = cli_flags(cli, "pcb", "export", "step")
    if not h:
        return None
    cmd = [cli, "pcb", "export", "step", "-o", out]
    for f in ("--subst-models", "--force", "--no-dnp"):
        if has_flag(h, f):
            cmd.append(f)
    return cmd + [board]


# ------------------------------------------------------------------ pipeline
def export_all(board_file, title="", revision="", company="", cfg=None, progress=None, cancel=None, lang="tr",
               board_copy=None):
    """board_file: the project's .kicad_pcb.  board_copy: an up-to-date copy saved from
    the editor (exports use it, so unsaved edits are included).  Returns the job dict."""
    cfg = cfg or load_config()
    say = progress or (lambda msg, frac=None: None)
    pdir = os.path.dirname(os.path.abspath(board_file))
    name = os.path.splitext(os.path.basename(board_file))[0]
    data_dir = os.path.join(pdir, "docs", "montaj")
    out_dir = os.path.join(data_dir, "kicad-export")
    os.makedirs(out_dir, exist_ok=True)
    src_board = board_copy if board_copy and os.path.isfile(board_copy) else board_file
    cli = find_kicad_cli(cfg)
    sch = os.path.join(pdir, name + ".kicad_sch")
    names = schematic_field_names(sch) if os.path.isfile(sch) else set()
    mfg, mpn = pick_field(names, MFG_FIELDS), pick_field(names, MPN_FIELDS)
    desc = "Description" if (not names or "Description" in names) else pick_field(names, ["Description", "Açıklama", "Desc"])
    warnings = []   # real problems: shown in KiCad
    notes = []      # information: shown in the assembly application
    tick = lambda: say(None)

    say("IPC-2581", 0.05)
    ipc = os.path.join(out_dir, name + ".xml")
    remove_quiet(ipc)
    t0 = time.time()
    code, txt = run(ipc2581_cmd(cli, src_board, ipc, mfg, mpn), cancel=cancel, tick=tick)
    if not fresh_output(ipc, t0):
        raise ExportError("IPC-2581 dışa aktarılamadı / export failed:\n" + txt[-1500:])

    bom = None
    say("BOM", 0.35)
    if os.path.isfile(sch):
        bom = os.path.join(out_dir, name + "_BOM.csv")
        cmd = bom_cmd(cli, sch, bom, mfg, mpn, desc)
        remove_quiet(bom)
        if cmd:
            t0 = time.time()
            code, txt = run(cmd, cancel=cancel, tick=tick)
            if not fresh_output(bom, t0):
                warnings.append("BOM: " + txt.strip()[-400:])
                bom = None
        else:
            bom = None
            warnings.append("BOM: kicad-cli sch export bom yok / not available")
    else:
        warnings.append("Şematik bulunamadı, IPC-2581 içindeki BOM kullanılacak / no schematic, using the BOM inside IPC-2581")

    step = None
    if cfg.get("export_step", True):
        say("STEP 3D", 0.55)
        step = os.path.join(out_dir, name + ".step")
        cmd = step_cmd(cli, src_board, step)
        remove_quiet(step)
        if cmd:
            t0 = time.time()
            code, txt = run(cmd, timeout=float(cfg.get("step_timeout", 1800)), cancel=cancel, tick=tick)
            if fresh_output(step, t0):
                notes += step_notes(txt, lang)        # written, maybe with skipped models
            else:
                warnings.append("STEP: " + txt.strip()[-400:])
                step = None
        else:
            step = None

    say("", 0.95)
    job = {
        "kind": "montaj-kicad-job", "version": 1, "plugin": VERSION,
        "pcb": os.path.abspath(board_file), "projectDir": pdir, "projectName": name,
        "title": title or name, "revision": revision, "company": company,
        "ipcFile": ipc, "bomFile": bom, "stepFile": step,
        "dataDir": data_dir, "lang": lang, "warnings": warnings, "notes": notes,
        "fields": {"manufacturer": mfg, "mpn": mpn, "description": desc},
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    job_file = os.path.join(data_dir, "kicad-job.json")
    with open(job_file + ".tmp", "w", encoding="utf-8") as f:
        json.dump(job, f, ensure_ascii=False, indent=1)
    os.replace(job_file + ".tmp", job_file)
    job["jobFile"] = job_file
    return job


def launch_app(job, cfg=None):
    app = find_app(cfg or load_config())
    args = [app, "--kicad-job=" + job["jobFile"]]
    if IS_WIN:
        subprocess.Popen(args, creationflags=DETACHED, close_fds=True, cwd=os.path.dirname(app))
    else:
        subprocess.Popen(args, close_fds=True, start_new_session=True, cwd=os.path.dirname(app))
    return app
