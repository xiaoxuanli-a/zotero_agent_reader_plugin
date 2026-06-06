// @ts-nocheck
/*
 * render.ts — render assistant Markdown + LaTeX math into SAFE HTML.
 *
 * Pipeline (the markdown/math + sanitization ordering matters):
 *   1. pull out math spans ($$..$$, \[..\], \(..\), $..$) → placeholder tokens
 *   2. marked() the placeholder'd text → HTML
 *   3. DOMPurify.sanitize() that HTML  — REQUIRED: the body is a privileged
 *      chrome node, and the model could be prompt-injected to emit <img onerror>
 *   4. katex.renderToString() each math span (trusted output) and substitute it
 *      back into the sanitized HTML at its token
 *
 * Returns an HTML string, or null when anything fails — callers MUST fall back
 * to plain textContent on null (never inject raw HTML).
 *
 * Vendored as npm deps (bundled by esbuild): marked, katex, dompurify. KaTeX's
 * stylesheet + fonts ship as static assets under addon/content/vendor/.
 */
import { marked } from "marked";
import katex from "katex";
import DOMPurify from "dompurify";

var _purify = null;
function getPurify(win) {
  if (_purify) return _purify;
  var D = DOMPurify;
  if (!D) return null;
  // The npm dompurify default export is callable as a factory: bind it to the
  // item-pane window so sanitization runs against that document. (A windowless
  // instance silently passes HTML through, which would defeat sanitization.)
  _purify = (typeof D === "function") ? D(win) : ((typeof D.sanitize === "function") ? D : null);
  return _purify;
}

// Order matters: consume $$...$$ / \[...\] / \(...\) before inline $...$.
var PATTERNS = [
  { re: /\$\$([\s\S]+?)\$\$/g, display: true },
  { re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  { re: /\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$/g, display: false },
];

function isMoney(t) { return /^[\s\d.,]+$/.test(t); }            // skip "$5", "$1,000"
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }
function tok(i) { return "KTXMATH" + i + "ENDKTX"; }             // survives marked + DOMPurify as plain text
function citeTok(i) { return "KTXCITE" + i + "ENDKTX"; }

// [p.N "verbatim quote"] / [p.N] / [pp.7-8 "..."]  — page + optional quote
var CITE_RE = /\[pp?\.?\s*(\d{1,4})(?:\s*[-–—]\s*\d{1,4})?\s*(?:["“”‘’']([^"“”‘’'\]]{0,200})["“”‘’'])?\s*\]/g;

export function render(text, win) {
  if (!marked || !katex || text == null) return null;

  var src = String(text);

  // Pull citations out FIRST (before math) so a quote that happens to contain
  // `$` isn't mistaken for math; substituted back (post-sanitize) as click targets.
  var cites = [];
  src = src.replace(CITE_RE, function (m, page, quote) {
    var i = cites.length;
    cites.push({ page: page, quote: quote || "" });
    return citeTok(i);
  });

  var maths = [];
  for (var p = 0; p < PATTERNS.length; p++) {
    var pat = PATTERNS[p];
    src = src.replace(pat.re, function (m, tex) {
      if (!pat.display && isMoney(tex)) return m;
      var i = maths.length;
      maths.push({ tex: tex, display: pat.display });
      return pat.display ? ("\n\n" + tok(i) + "\n\n") : tok(i);
    });
  }

  var html;
  try { html = marked.parse ? marked.parse(src, { gfm: true, breaks: true }) : marked(src); }
  catch (e) { return null; }

  var pf = getPurify(win);
  if (!pf) return null;                       // refuse to inject unsanitized HTML
  try { html = pf.sanitize(html, { ADD_ATTR: ["target", "rel"] }); }
  catch (e) { return null; }

  for (var j = 0; j < maths.length; j++) {
    var out;
    try {
      out = katex.renderToString(maths[j].tex, { displayMode: maths[j].display, throwOnError: false });
    } catch (e) {
      var d = maths[j].display ? "$$" : "$";
      out = esc(d + maths[j].tex + d);
    }
    html = html.split(tok(j)).join(out);
  }

  // substitute citation placeholders with clickable spans (chatPanel wires the
  // click → Zotero.Reader navigation; <span>, not <a>, to bypass the launchURL handler)
  for (var c = 0; c < cites.length; c++) {
    var ct = cites[c];
    var span = '<span class="pra-cite" data-page="' + esc(ct.page) + '"' +
      (ct.quote ? ' title="' + escAttr(ct.quote) + '"' : "") +
      '>[p.' + esc(ct.page) + ']</span>';
    html = html.split(citeTok(c)).join(span);
  }

  // Self-close void elements (<br> → <br/>, etc.). The Zotero item-pane document
  // parses innerHTML as strict XHTML, where a bare <br> is malformed and THROWS;
  // marked (breaks:true) emits <br>, so normalize before it reaches innerHTML.
  html = html.replace(/<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b([^>]*?)\s*\/?>/gi, "<$1$2/>");
  return html;
}
