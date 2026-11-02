# -*- coding: utf-8 -*-
"""Montaj Görüntüleyici – KiCad PCB editor action plugin (KiCad 8 / 9 / 10, SWIG runtime)."""
import glob
import os
import traceback

import pcbnew
import wx

from . import exporter

TXT = {
    "tr": {
        "name": "Montaj Görüntüleyici",
        "desc": "IPC-2581, BOM ve STEP dışa aktarır ve dizgi (montaj) takip programını açar",
        "title": "Montaj Görüntüleyici",
        "nofile": "Önce kartı kaydedin (dosya adı yok).",
        "prep": "Kart hazırlanıyor…",
        "IPC-2581": "IPC-2581 dışa aktarılıyor…",
        "BOM": "BOM dışa aktarılıyor…",
        "STEP 3D": "3D model (STEP) dışa aktarılıyor… büyük kartlarda bir dakika sürebilir",
        "launch": "Montaj programı açılıyor…",
        "fail": "Dışa aktarma başarısız",
        "warn": "Montaj programı açıldı. Uyarılar:",
        "nocli": "kicad-cli bulunamadı. montaj_kicad.json dosyasında \"kicad_cli\" yolunu belirtin.",
    },
    "en": {
        "name": "Assembly Viewer",
        "desc": "Exports IPC-2581, BOM and STEP and opens the assembly tracking application",
        "title": "Assembly Viewer",
        "nofile": "Save the board first (it has no file name).",
        "prep": "Preparing the board…",
        "IPC-2581": "Exporting IPC-2581…",
        "BOM": "Exporting BOM…",
        "STEP 3D": "Exporting 3D model (STEP)… this can take a minute on large boards",
        "launch": "Opening the assembly application…",
        "fail": "Export failed",
        "warn": "The assembly application was opened. Warnings:",
        "nocli": "kicad-cli not found. Set \"kicad_cli\" in montaj_kicad.json.",
    },
}


def lang():
    try:
        loc = wx.GetLocale()
        name = (loc.GetCanonicalName() if loc else "") or ""
    except Exception:
        name = ""
    return "tr" if name.lower().startswith("tr") else "en"


def tr(key):
    return TXT[lang()].get(key, key)


def _save_copy(board):
    """Save the board as currently edited to a hidden sibling file; returns its path or None."""
    fn = board.GetFileName()
    pdir, base = os.path.split(fn)
    tmp = os.path.join(pdir, "_montaj_tmp_" + base)
    try:
        try:
            ok = pcbnew.SaveBoard(tmp, board, True)   # skip project settings (KiCad 7+)
        except TypeError:
            ok = pcbnew.SaveBoard(tmp, board)
        return tmp if ok is not False and os.path.isfile(tmp) else None
    except Exception:
        return None


def _cleanup(tmp):
    if not tmp:
        return
    stem = os.path.splitext(tmp)[0]
    for f in [tmp] + glob.glob(stem + ".kicad_pr*") + glob.glob(stem + "-backups"):
        try:
            if os.path.isdir(f):
                continue
            os.remove(f)
        except OSError:
            pass


class MontajPlugin(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = tr("name")
        self.category = "Montaj"
        self.description = tr("desc")
        self.show_toolbar_button = True
        here = os.path.dirname(os.path.abspath(__file__))
        self.icon_file_name = os.path.join(here, "icon.png")
        self.dark_icon_file_name = os.path.join(here, "icon_dark.png")

    def Run(self):
        parent = wx.GetActiveWindow() or None
        board = pcbnew.GetBoard()
        fn = board.GetFileName() if board else ""
        if not fn:
            wx.MessageBox(tr("nofile"), tr("title"), wx.OK | wx.ICON_WARNING, parent)
            return
        tb = board.GetTitleBlock()
        title, rev, company = tb.GetTitle(), tb.GetRevision(), tb.GetCompany()

        dlg = wx.ProgressDialog(tr("title"), tr("prep"), maximum=100, parent=parent,
                                style=wx.PD_APP_MODAL | wx.PD_CAN_ABORT | wx.PD_AUTO_HIDE | wx.PD_ELAPSED_TIME | wx.PD_SMOOTH)
        state = {"cancel": False, "label": tr("prep")}

        def progress(msg, frac=None):
            if msg:
                state["label"] = tr(msg)
            if frac is None:
                cont, _ = dlg.Pulse(state["label"])
            else:
                cont, _ = dlg.Update(min(99, int(frac * 100)), state["label"])
            if not cont:
                state["cancel"] = True
            wx.Yield()

        tmp = None
        try:
            tmp = _save_copy(board)
            job = exporter.export_all(fn, title=title, revision=rev, company=company, progress=progress,
                                      cancel=lambda: state["cancel"], lang=lang(), board_copy=tmp)
            progress("launch", 0.98)
            exporter.launch_app(job)
            dlg.Update(100)
        except exporter.ExportError as e:
            dlg.Destroy()
            dlg = None
            msg = str(e)
            if "kicad-cli" in msg and "bulunamadı" in msg:
                msg = tr("nocli")
            wx.MessageBox(msg, tr("fail"), wx.OK | wx.ICON_ERROR, parent)
            return
        except Exception:
            if dlg:
                dlg.Destroy()
                dlg = None
            wx.MessageBox(traceback.format_exc()[-2000:], tr("fail"), wx.OK | wx.ICON_ERROR, parent)
            return
        finally:
            _cleanup(tmp)
            if dlg:
                dlg.Destroy()
        if job.get("warnings"):
            wx.MessageBox(tr("warn") + "\n\n" + "\n".join(job["warnings"]), tr("title"), wx.OK | wx.ICON_INFORMATION, parent)
