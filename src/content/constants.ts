/**
 * content script 内部共享常量。
 *
 * 所有注入的 DOM 节点都会带 `data-wordmark`，这既是「自己人」的
 * 标记（避免二次处理），也是卸载时精确回滚的依据。
 */

export const MARK_ATTR = 'data-wordmark';
export const MARK_SELECTOR = `[${MARK_ATTR}]`;
export const MARK_CLASS = 'wordmark-gloss';
export const DEF_CLASS = 'wordmark-def';
export const TOAST_CLASS = 'wordmark-toast';
export const LEMMA_ATTR = 'data-wordmark-lemma';
/**
 * 每一处标注的唯一编号。
 *
 * 为什么需要它：语境义是**逐处**的——同一个词在两个句子里可能对应两个义项，
 * 所以不能用词元（lemma）当更新键，必须能精确定位到某一次渲染出来的那个释义节点。
 */
export const GLOSS_ID_ATTR = 'data-wordmark-gloss-id';

/** 根节点上的状态类，样式全部由 content.css 提供（兼容严格 CSP）。 */
export const ROOT_CLASS = 'wordmark-active';
export const ROOT_STYLE_PREFIX = 'wordmark-style-';

/**
 * 这些标签内的文本不是「正文」，标注只会变成噪音或破坏功能：
 * 代码、表单控件、SVG/公式、以及嵌入内容。
 */
export const SKIP_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'OPTGROUP',
  'BUTTON',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'VAR',
  'TT',
  'SVG',
  'MATH',
  'CANVAS',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'VIDEO',
  'AUDIO',
  'MAP',
  'AREA',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
]);

/**
 * 逐级向上判断是否位于忽略区。注意 `[contenteditable]` 用属性前缀
 * 选择器，因为它的值可能是 ""、"true"、"plaintext-only"。
 */
export const SKIP_SELECTOR = [
  MARK_SELECTOR,
  '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]',
  '[aria-hidden="true"]',
  '[hidden]',
  '[translate="no"]',
  '.notranslate',
].join(',');
