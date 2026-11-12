import { execFileSync } from 'node:child_process'
import { readFileSync,writeFileSync } from 'node:fs'
import { resolve,join } from 'node:path'
const local=resolve('scripts/precise-word-timing/local'),read=p=>JSON.parse(readFileSync(p,'utf8'))
const prefix=process.argv[2]??'';if(!['','fp32-'].includes(prefix))throw Error('Unknown measurement variant')
writeFileSync(join(local,prefix+'both-runtime.json'),JSON.stringify({runtime:['en','cs'].map(l=>read(join(local,`${prefix}${l}-runtime.json`)))},null,2))
writeFileSync(join(local,prefix+'both-placements.json'),JSON.stringify(['en','cs'].flatMap(l=>read(join(local,`${prefix}${l}-placements.json`)))))
execFileSync(process.execPath,[resolve('scripts/measure-cut-point-corpus.mjs')],{cwd:join(local,prefix+'both-scores'),stdio:'inherit'})
