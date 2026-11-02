# -*- coding: utf-8 -*-
# Montaj Görüntüleyici – KiCad plugin entry point
try:
    from .plugin import MontajPlugin
    MontajPlugin().register()
except Exception as e:  # never break KiCad's plugin loading
    import logging
    logging.getLogger("montaj_kicad").exception(e)
