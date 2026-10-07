/*
 * PDFのページの区切り位置を測る、ブラウザの中で実行するスクリプト(page.evaluateに、文字列として渡す)。
 *
 * 本文(body.document)を、PDFの1ページの本文領域(幅 × 高さ。CSSピクセル)の「段」にして、段組みで折り返す。
 * ブラウザは、印刷のページ分割と同じ仕組み(見出しの直後で改ページしない・表の行を途中で切らない・
 * 行の孤立を避けるなど)で、段にも内容を分割するため、各段が、PDFの1ページにあたる。
 * 本文を、先頭から順に調べ、新しい段に入った最初の文字(または画像・水平線)の位置を、ページの区切りとして返す。
 *
 * - 型の無い文字列にしているのは、サーバ(DOMの型を持たない)でビルドしつつ、ブラウザの中で実行するため
 * - 空白は、判断の揺れを避けるため、文字数に数えない(画面側も、同じ数え方で位置を探す)
 * - 空行(「&nbsp;」だけの段落)は、文字ではないが、1行分の空きとして、ページの上端にも現れる。
 *   空行の途中でページが替わるときは、その空行の前を、ページの区切りにする(次の文字の前ではない)
 */
export const MEASURE_PAGES_SCRIPT = `(function (pageWidth, pageHeight) {
  var style = document.createElement('style');
  style.textContent =
    'html, body { margin: 0 !important; padding: 0 !important; }' +
    'body.document { width: ' + pageWidth + 'px; height: ' + pageHeight + 'px; column-width: ' + pageWidth + 'px; column-gap: 0; column-fill: auto; }' +
    // 手動の改ページ(PDFでは break-after: page)は、段組みでは、段の区切りにする(文書のCSSより優先するため、詳しく書く)
    'body.document .manual-page-break { break-after: column; }';
  document.head.appendChild(style);

  var body = document.body;
  var originX = body.getBoundingClientRect().left;
  var blocks = Array.prototype.slice.call(body.children);
  var WS = /\\s/;
  var NON_WS = /\\S/;

  // x座標が、何番目の段(0始まり)か。段の左端のわずかな誤差は、次の段に含める
  function columnOf(x) {
    return Math.floor((x - originX + 1) / pageWidth);
  }

  function textNodesIn(root) {
    var nodes = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push(node);
    }
    return nodes;
  }

  function countNonWs(text) {
    return text.replace(/\\s+/g, '').length;
  }

  // テキストノードの i 文字目の、左端のx座標。表示されない文字(空白など)は null
  var range = document.createRange();
  function charLeft(node, index) {
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    var rects = range.getClientRects();
    return rects.length > 0 && rects[0].width > 0 ? rects[0].left : null;
  }

  function charColumn(node, index) {
    var left = charLeft(node, index);
    return left === null ? null : columnOf(left);
  }

  function topLevelBlock(node) {
    var current = node.nodeType === 3 ? node.parentNode : node;
    while (current && current.parentNode !== body) {
      current = current.parentNode;
    }
    return current;
  }

  // 新しいページの最初の位置(leaf: テキストノードか、画像・水平線の要素。index: テキストノードの何文字目か)
  function anchorFor(leaf, index, page) {
    var block = topLevelBlock(leaf);
    var position = blocks.indexOf(block);
    if (position < 0) {
      return null;
    }
    var tag = block.tagName.toLowerCase();
    // Markdownでのブロックの番号(data-block)。付いていなければ、本文の最上位の要素の並びの番号
    var tagged = block.getAttribute('data-block');
    var blockIndex = tagged === null ? position : Number(tagged);
    var base = { page: page, block: blockIndex, tag: tag, snippet: snippetFrom(leaf, index) };

    if (tag === 'table') {
      var row = leaf.nodeType === 3 ? leaf.parentNode.closest('tr') : leaf.closest('tr');
      var rowIndex = row ? Array.prototype.indexOf.call(block.querySelectorAll('tr'), row) : 0;
      return rowIndex > 0 ? Object.assign(base, { kind: 'row', index: rowIndex }) : Object.assign(base, { kind: 'start' });
    }
    if (tag === 'pre') {
      var before = 0;
      var nodes = textNodesIn(block);
      for (var i = 0; i < nodes.length && nodes[i] !== leaf; i++) {
        before += nodes[i].data.length;
      }
      var text = block.textContent.slice(0, before + index);
      var line = text.split('\\n').length - 1;
      return line > 0 ? Object.assign(base, { kind: 'line', index: line }) : Object.assign(base, { kind: 'start' });
    }

    // 段落・見出し・リストなど: 空白を除いた文字数で、ブロックの中の位置を表す
    var offset = 0;
    var all = textNodesIn(block);
    for (var j = 0; j < all.length; j++) {
      if (all[j] === leaf) {
        offset += countNonWs(all[j].data.slice(0, index));
        break;
      }
      // 画像・水平線の前にある文字を数える(要素の場合は、要素より前のテキストノードだけ)
      if (leaf.nodeType === 1 && (all[j].compareDocumentPosition(leaf) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
        break;
      }
      offset += countNonWs(all[j].data);
    }
    return offset > 0 ? Object.assign(base, { kind: 'text', offset: offset }) : Object.assign(base, { kind: 'start' });
  }

  // 新しいページの最初から、空白を除いた24文字まで
  function snippetFrom(leaf, index) {
    if (leaf.nodeType !== 3) {
      return '';
    }
    var out = '';
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    walker.currentNode = leaf;
    var text = leaf.data.slice(index);
    for (var node = leaf; node && out.length < 24; node = walker.nextNode()) {
      out += (node === leaf ? text : node.data).replace(/\\s+/g, '');
    }
    return out.slice(0, 24);
  }

  var starts = [];
  var currentPage = 0;

  function noteStart(column, leaf, index) {
    currentPage = column;
    var anchor = anchorFor(leaf, index, column + 1);
    if (anchor) {
      starts.push(anchor);
    }
  }

  // 空行(「&nbsp;」だけの段落)。文字は無いが、PDFでは1行分の空きとして、ページの上端にも現れる
  function isBlankParagraph(element) {
    return (
      element.tagName === 'P' &&
      element.parentNode === body &&
      element.childNodes.length > 0 &&
      !NON_WS.test(element.textContent) &&
      element.querySelector('img, hr, br') === null
    );
  }

  var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (var node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if (isBlankParagraph(node)) {
        // 高さの無い段落(空白だけで、行にならないもの)は、PDFでも空きにならないため、数えない
        var blankRect = node.getBoundingClientRect();
        if (blankRect.height > 0) {
          var blankColumn = columnOf(blankRect.left);
          if (blankColumn > currentPage) {
            noteStart(blankColumn, node, 0);
          }
        }
        continue;
      }
      // 文字の無い要素(画像・水平線)も、ページの先頭になりうる
      if (node.tagName === 'IMG' || node.tagName === 'HR') {
        var rect = node.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          var column = columnOf(rect.left);
          if (column > currentPage) {
            noteStart(column, node, 0);
          }
        }
      }
      continue;
    }
    var data = node.data;
    if (!NON_WS.test(data)) {
      continue;
    }
    // 空白でない文字の位置(インデックス)
    var indexes = [];
    for (var k = 0; k < data.length; k++) {
      if (!WS.test(data[k])) {
        indexes.push(k);
      }
    }
    var from = 0; // indexes の中の、調べ始める位置
    while (from < indexes.length) {
      var first = null;
      while (from < indexes.length && (first = charColumn(node, indexes[from])) === null) {
        from++;
      }
      if (from >= indexes.length || first === null) {
        break;
      }
      if (first > currentPage) {
        noteStart(first, node, indexes[from]);
      }
      var last = null;
      for (var m = indexes.length - 1; m >= from && last === null; m--) {
        last = charColumn(node, indexes[m]);
      }
      if (last === null || last <= currentPage) {
        break;
      }
      // このテキストが、次のページにまたがる: 次のページに入る最初の文字を、二分探索で探す
      var lo = from;
      var hi = indexes.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        var midColumn = charColumn(node, indexes[mid]);
        if (midColumn === null) {
          // 表示されない文字は、次に表示される文字で判断する
          var probe = mid + 1;
          while (probe <= hi && charColumn(node, indexes[probe]) === null) {
            probe++;
          }
          midColumn = probe <= hi ? charColumn(node, indexes[probe]) : last;
        }
        if (midColumn > currentPage) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      from = lo;
    }
  }

  return { pages: currentPage + 1, starts: starts };
})`;
