/**
 * 多义项表的 shape 常量。
 *
 * 生成器、构建校验、数据测试共用这一份，避免同一个数字在三个文件里各写一遍——
 * 那样调一下原子上限，就有一处校验会静默失配。
 *
 * 单条义项由最多 `MAX_ATOMS_PER_SENSE` 个「原子」用 `/` 连接，单原子 ≤ `MAX_ATOM_CHARS` 字，
 * 所以长度上限是**推导出来的**：
 *
 *   MAX_SENSE_CHARS = MAX_ATOM_CHARS × MAX_ATOMS_PER_SENSE + (分隔符)
 *
 * 注意它与词表里那条 14 字的 `gloss` 规则是两回事：`gloss` 是给读者看的展示释义，
 * 义项是给打分器做选择题用的候选。
 */

export const MAX_SENSES_PER_WORD = 6;
export const MAX_ATOM_CHARS = 10;
export const MAX_ATOMS_PER_SENSE = 3;
export const MAX_SENSE_CHARS =
  MAX_ATOM_CHARS * MAX_ATOMS_PER_SENSE + (MAX_ATOMS_PER_SENSE - 1);
