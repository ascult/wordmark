/**
 * `senses-schema.mjs` 的类型声明。
 *
 * 那份常量必须被构建脚本（node 直跑的 .mjs）和数据测试（TS）共用，所以实体是 .mjs；
 * TS 侧靠这个 .d.mts 拿到类型。数字的唯一来源仍然是 .mjs。
 */
export declare const MAX_SENSES_PER_WORD: number;
export declare const MAX_ATOM_CHARS: number;
export declare const MAX_ATOMS_PER_SENSE: number;
export declare const MAX_SENSE_CHARS: number;
