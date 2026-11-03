"""Check the PDF against the editable URL commands in its LaTeX source.

Install: python -m pip install pypdf pymupdf
Run: python scripts/verify_submission.py
"""
from pathlib import Path
import re
from pypdf import PdfReader
import pymupdf

root = Path(__file__).resolve().parent.parent
source = root / 'submission/Tanish_Gupta_Outbox_Assignment.tex'
pdf = source.with_suffix('.pdf')
text = source.read_text(encoding='utf-8')
urls = [re.search(r'\\newcommand\{\\' + name + r'\}\{([^}]*)\}', text).group(1)
        for name in ('HostedURL', 'VideoURL', 'RepositoryURL')]
reader = PdfReader(pdf)
assert len(reader.pages) == 1, 'Submission must be one page'
assert pdf.stat().st_size < 5_000_000, 'Submission must be under 5 MB'
targets = [annotation.get_object().get('/A', {}).get('/URI')
           for annotation in reader.pages[0].get('/Annots', [])]
assert sorted(targets) == sorted(url for url in urls if url), (targets, urls)
assert all(url.startswith('https://') for url in targets), 'Use real HTTPS URLs'
has_draft = 'submission links pending' in reader.pages[0].extract_text()
assert has_draft == any(not url for url in urls), 'Draft marking does not match links'
render_dir = root / 'tmp/pdfs'
render_dir.mkdir(parents=True, exist_ok=True)
document = pymupdf.open(pdf)
document[0].get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5)).save(render_dir / 'submission.png')
print(f'PASS: one page, {pdf.stat().st_size} bytes; {len(targets)} verified link target(s); draft={has_draft}')
for target in targets:
    print(target)
print('Rendered tmp/pdfs/submission.png; inspect it before submitting.')
