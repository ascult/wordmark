# 外部导入的词表

本目录存放**从外部项目导入**的词条，与 `data/parts/` 里人工整理的分片分开放，
合并时发生冲突以人工分片为准（见 `scripts/build-dict.mjs`）。

## cet4.json —— 2,602 条

- **来源**：[TypeWords](https://github.com/zyronon/TypeWords) 公开仓库中的
  `public/dicts/en/word/CET4_T.json`（2,607 条）。
- **许可**：TypeWords 以 **GPL-3.0** 发布，与本项目（GPL-3.0-or-later）兼容。
  本目录中的文件是该项目数据的**衍生作品**（做了字段裁剪与释义压缩），因此同样按 GPL-3.0 分发。
  该数据集的上游出处 TypeWords 仓库未另行说明，如用于商业分发请自行确认。
- **只用了两个字段**：`word`（词元）与 `trans[].cn` / `trans[].pos`（中文释义与词性）。
  源数据里的例句、词源、同义词等字段未使用。
- **重生成方式**（需要先自行 clone TypeWords，本仓库不包含它）：

  ```bash
  git clone --depth 1 git@github.com:zyronon/TypeWords.git .tmp-ref/TypeWords
  npm run import:dict -- .tmp-ref/TypeWords/public/dicts/en/word/CET4_T.json cet4 data/imported/cet4.json \
    --common=data/reference/common-words-a.json --common=data/reference/common-words-b.json
  ```

- **转换细节**：见 `scripts/import-typewords.mjs` 与 `tests/import.condense.test.mjs`。
  两档划分结果：`cet4` 2,086 条 / `basic` 516 条（合并进总表后分别为 2,060 与 434，
  差异来自与人工分片重叠的 310 条——人工词条优先）。

TypeWords 公开仓库里**只有 CET-4** 这一份词库（其余词库在它的服务端，未开源），
所以目前只借到了 CET-4。想要 CET-6 / IELTS / GRE，需要另外找数据源或自行整理。
