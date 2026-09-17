import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ponytailPolicy, ponytailPrompt, runPonytail } from './yano-ponytail.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yano-ponytail-'));
const previous = process.env.YANO_DATA_DIR;
process.env.YANO_DATA_DIR = path.join(temp, 'data');
const a = path.join(temp, 'alpha'), b = path.join(temp, 'beta');
fs.mkdirSync(a); fs.mkdirSync(b);
try {
  assert.equal(ponytailPolicy(a).mode, 'full');
  assert.match(ponytailPrompt(a), /The ladder/);
  runPonytail({cwd:a,argv:['off']});
  assert.equal(ponytailPolicy(a).enabled, false);
  assert.equal(ponytailPolicy(b).enabled, true);
  assert.doesNotMatch(ponytailPrompt(a), /The ladder/);
  runPonytail({cwd:a,argv:['off','--global']});
  assert.equal(ponytailPolicy(b).enabled, false);
  runPonytail({cwd:a,argv:['lite']});
  assert.equal(ponytailPolicy(a).mode, 'lite');
  assert.equal(ponytailPolicy(a).source, 'project');
  runPonytail({cwd:a,argv:['reset']});
  assert.equal(ponytailPolicy(a).mode, 'off');
  runPonytail({cwd:a,argv:['reset','--global']});
  assert.equal(ponytailPolicy(a).mode, 'full');
  assert.throws(()=>runPonytail({cwd:a,argv:['invalid']}),/non valida/);
  assert.throws(()=>runPonytail({cwd:a,argv:['off','--project-root']}),/directory/);
} finally {
  if (previous === undefined) delete process.env.YANO_DATA_DIR; else process.env.YANO_DATA_DIR=previous;
  fs.rmSync(temp,{recursive:true,force:true});
}
console.log('PONYTAIL default, project/global opt-out and reset passed');
