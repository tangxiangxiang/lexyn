import { expect, test } from 'vitest'
import { parseDictionaryMeaning } from './parse.ts'

const samples = [
  ['file', 'n. 档案, 文件夹\\nvi. 列队行进\\nvt. 归档, 申请\\n[计] 文件', ['n.', 'vi.', 'vt.', ''], 6],
  ['command', 'n. 命令, 控制\\nv. 指挥\\n[计] 命令; DOS外部命令:启动新的命令处理器', ['n.', 'v.', ''], 4],
  ['record', 'n. 记录\nvt. 记载\nvi. 录音\na. 创纪录的\n[计] 录制', ['n.', 'vt.', 'vi.', 'a.', ''], 5],
  ['present', 'n. 现在, 礼品\na. 出席的\nvt. 呈现\nvi. 举枪瞄准', ['n.', 'a.', 'vt.', 'vi.'], 5],
  ['object', 'n. 目标, 对象\\nvi. 反对\\nvt. 提出...来反对', ['n.', 'vi.', 'vt.'], 4],
  ['process', 'n. 过程\nvt. 加工\n[计] 进程', ['n.', 'vt.', ''], 3],
  ['thread', 'n. 线, 丝\\nvt. 穿线于\\nvi. 穿过\\n[计] 线索, 线程', ['n.', 'vt.', 'vi.', ''], 6],
  ['spring', 'n. 春天, 弹簧\\na. 春天的\\nvi. 跳\\nvt. 使跳起', ['n.', 'a.', 'vi.', 'vt.'], 5],
  ['volatile', 'a. 挥发性的, 不稳定的\\nn. 挥发物\\n[计] 易失的', ['a.', 'n.', ''], 4],
  ['run', 'n. 跑, 赛跑\\nvi. 奔跑\\nrun的过去式和过去分词\\n[计] 运行', ['n.', 'vi.', '', ''], 5],
  ['set', 'vt. 放, 设定\\n[计] 设置; DOS内部命令:改变环境变量', ['vt.', ''], 3],
  ['lead', 'n. 铅, 领导\nvt. 引导\nvi. 带头', ['n.', 'vt.', 'vi.'], 4],
  ['read', 'v. 读, 阅读\na. 有学问的\nn. 读取', ['v.', 'a.', 'n.'], 4],
] as const

test.each(samples)('preserves %s raw text and its independent groups', (word, raw, parts, count) => {
  const result = parseDictionaryMeaning(word, raw, 'fixture')!
  expect(result).toMatchObject({ sourceWord: word, sourceRevision: 'fixture', rawTranslation: raw })
  expect(result.senses.map(({ partOfSpeech }) => partOfSpeech)).toEqual(parts)
  expect(result.senses.flatMap(({ definitions }) => definitions)).toHaveLength(count)
  for (const sense of result.senses) {
    expect(sense.source).toBe('ecdict')
    for (const definition of sense.definitions) expect(raw).toContain(definition)
  }
})

test('preserves uncommon POS, abbreviation, nested punctuation and ambiguous delimiters without guessing', () => {
  const raw = 'abbr. 美国\r\naux-v. （辅助, 修饰）, 协助, 协助\n[计] 配置；用法：写入, 运行\n未标注、说明\nvt. 括号未合（, 内容'
  const result = parseDictionaryMeaning('US', raw)!
  expect(result.rawTranslation).toBe(raw)
  expect(result.partiallyStructured).toBe(true)
  expect(result.senses).toEqual([
    { partOfSpeech: 'abbr.', definitions: ['美国'], source: 'ecdict' },
    { partOfSpeech: 'aux-v.', definitions: ['（辅助, 修饰）', '协助'], source: 'ecdict' },
    { partOfSpeech: '', domain: '计', definitions: ['配置；用法：写入, 运行'], source: 'ecdict' },
    { partOfSpeech: '', definitions: ['未标注、说明'], source: 'ecdict' },
    { partOfSpeech: 'vt.', definitions: ['括号未合（, 内容'], source: 'ecdict' },
  ])
  expect(parseDictionaryMeaning('empty', ' \n ')).toBeUndefined()
})

test('retains raw data when a source line exceeds the structured size limit', () => {
  const raw = 'n. 可解析\\n' + '未标注'.repeat(500)
  expect(parseDictionaryMeaning('sample', raw)).toMatchObject({
    rawTranslation: raw, partiallyStructured: true, senses: [{ partOfSpeech: 'n.', definitions: ['可解析'] }],
  })
})
