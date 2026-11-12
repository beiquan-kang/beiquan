import unittest
from assemble_reports import compose, ORDER

class AssembleTests(unittest.TestCase):
    def test_order_and_default(self):
        raw='<html><div class="report-tabs">old</div>'+''.join(f'<nav data-report-nav="{k}"><a>{k}</a></nav>' for k in ['hk','macro','strategy','sectors'])+''.join(f'<div data-report-panel="{k}"><div>test</div></div>' for k in ['hk','macro','strategy','sectors'])+"<script>activate(location.hash.startsWith('#macro-')?'macro':'hk',false)</script></html>"
        result=compose(raw)
        offsets=[result.index('data-report="'+k+'"') for k,_ in ORDER]
        self.assertEqual(offsets, sorted(offsets))
        self.assertIn("?'hk':'macro',false)", result)
        self.assertEqual(result.count('data-report-panel='),4)
    def test_missing_page_rejected(self):
        with self.assertRaises(ValueError):compose('<html></html>')
if __name__=='__main__':unittest.main()
