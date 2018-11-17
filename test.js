const crossSpawn = require('cross-spawn');
const deasync = require('deasync-promise');
const glob = require('glob-all');
const JSZip = require('jszip');
const tape = require('tape');

const { removeSync, readFileSync, pathExistsSync, copySync } = require('fs-extra');
const { sep } = require('path');

const { getUserCachePath } = require('./lib/shared');

const initialWorkingDir = process.cwd();

const mkCommand = cmd => (args, options = {}) => {
  const { error, stdout, stderr, status } = crossSpawn.sync(
    cmd,
    args,
    Object.assign(
      {
        env: Object.assign(
          process.env,
          { SLS_DEBUG: 't' },
          process.env.CI ? { LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' } : {}
        )
      },
      options
    )
  );
  if (error) throw error;
  if (status) {
    console.error(stdout.toString()); // eslint-disable-line no-console
    console.error(stderr.toString()); // eslint-disable-line no-console
    throw new Error(`${cmd} failed with status code ${status}`);
  }
  return stdout && stdout.toString().trim();
};
const sls = mkCommand('sls');
const git = mkCommand('git');
const npm = mkCommand('npm');
const perl = mkCommand('perl');

const setup = () => {
  removeSync(getUserCachePath());
};

const teardown = () => {
  [
    'puck',
    'puck2',
    'puck3',
    'node_modules',
    '.serverless',
    '.requirements.zip',
    '.requirements-cache',
    'foobar',
    'package-lock.json',
    'slimPatterns.yml',
    'serverless.yml.bak',
    getUserCachePath(),
    ...glob.sync('serverless-python-requirements-*.tgz')
  ].map(path => removeSync(path));
  git(['checkout', 'serverless.yml']);
  process.chdir(initialWorkingDir);
  removeSync('tests/base with a space');
};

const test = (desc, func, opts = {}) =>
  tape.test(desc, opts, t => {
    setup();
    try {
      func(t);
    } finally {
      teardown();
    }
  });

const getPythonBin = (version = 3) => {
  if (![2, 3].includes(version)) throw new Error('version must be 2 or 3');
  if (process.platform === 'win32')
    return `c:/python${version === 2 ? '27' : '36'}-x64/python.exe`;
  else return version === 2 ? 'python2.7' : 'python3.6';
};

const listZipFiles = filename =>
  Object.keys(deasync(new JSZip().loadAsync(readFileSync(filename))).files);
const listRequirementsZipFiles = filename => {
  const zip = deasync(new JSZip().loadAsync(readFileSync(filename)));
  const reqsBuffer = deasync(zip.file('.requirements.zip').async('nodebuffer'));
  const reqsZip = deasync(new JSZip().loadAsync(reqsBuffer));
  return Object.keys(reqsZip.files);
};

const canUseDocker = () => {
  let result;
  try {
    result = crossSpawn.sync('docker', ['ps']);
  } catch (e) {
    return false;
  }
  return result.status === 0;
};

test('default pythonBin can package flask with default options', t => {
  process.chdir('tests/base');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  sls(['package']);
  const zipfiles = listZipFiles('.serverless/sls-py-req-test.zip');
  t.true(zipfiles.includes(`flask${sep}__init__.py`), 'flask is packaged');
  t.end();
});

test('py3.6 can package flask with default options', t => {
  process.chdir('tests/base');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  sls([`--pythonBin=${getPythonBin(3)}`, 'package']);
  const zipfiles = listZipFiles('.serverless/sls-py-req-test.zip');
  t.true(zipfiles.includes(`flask${sep}__init__.py`), 'flask is packaged');
  t.end();
});

test('py3.6 can package flask with zip option', t => {
  process.chdir('tests/base');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  sls([`--pythonBin=${getPythonBin(3)}`, '--zip=true', 'package']);
  const zipfiles = listZipFiles('.serverless/sls-py-req-test.zip');
  t.true(
    zipfiles.includes('.requirements.zip'),
    'zipped requirements are packaged'
  );
  t.true(zipfiles.includes(`unzip_requirements.py`), 'unzip util is packaged');
  t.false(
    zipfiles.includes(`flask${sep}__init__.py`),
    "flask isn't packaged on its own"
  );
  t.end();
});

test('py3.6 can package flask with slim option', t => {
  process.chdir('tests/base');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  sls([`--pythonBin=${getPythonBin(3)}`, '--slim=true', 'package']);
  const zipfiles = listZipFiles('.serverless/sls-py-req-test.zip');
  t.true(zipfiles.includes(`flask${sep}__init__.py`), 'flask is packaged');
  t.deepEqual(
    zipfiles.filter(filename => filename.endsWith('.pyc')),
    [],
    'no pyc files packaged'
  );
  t.end();
});

test('can package individually without moving modules to root of zip-File', t => {
  process.chdir('tests/base');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  sls(['--individually=true', '--moveup=false', 'package']);

  const zipfiles_hello = listZipFiles('.serverless/hello.zip');
  t.false(
    zipfiles_hello.includes(`fn2${sep}__init__.py`),
    'fn2 is not packaged in function hello'
  );
  t.true(
    zipfiles_hello.includes('handler.py'),
    'handler.py is packaged in function hello'
  );
  t.false(
    zipfiles_hello.includes(`dataclasses.py`),
    'dataclasses is not packaged in function hello'
  );
  t.true(
    zipfiles_hello.includes(`flask${sep}__init__.py`),
    'flask is packaged in function hello'
  );

  const zipfiles_hello4 = listZipFiles('.serverless/hello4.zip');
  t.true(
    zipfiles_hello4.includes(`fn2${sep}__init__.py`),
    'fn2 is packaged as module in function hello4'
  );
  t.true(
    zipfiles_hello4.includes(`dataclasses.py`),
    'dataclasses is packaged in function hello4'
  );
  t.false(
    zipfiles_hello4.includes(`flask${sep}__init__.py`),
    'flask is not packaged in function hello4'
  );
  t.false(
    zipfiles_hello4.includes(`common${sep}__init__.py`),
    'module common is not packaged in function hello4'
  );

  const zipfiles_hello5 = listZipFiles('.serverless/hello5.zip');
  t.true(
    zipfiles_hello5.includes(`fn2${sep}__init__.py`),
    'fn2 is packaged as module in function hello5'
  );
  t.true(
    zipfiles_hello5.includes(`dataclasses.py`),
    'dataclasses is packaged in function hello5'
  );
  t.false(
    zipfiles_hello5.includes(`flask${sep}__init__.py`),
    'flask is not packaged in function hello5'
  );
  t.true(
    zipfiles_hello5.includes(`common${sep}__init__.py`),
    'module common is packaged in function hello5'
  );

  const zipfiles_hello6 = listZipFiles('.serverless/hello6.zip');
  t.true(
    zipfiles_hello6.includes(`fn3${sep}__init__.py`),
    'fn3 is packaged as module in function hello6'
  );
  t.false(
    zipfiles_hello6.includes(`fn2${sep}__init__.py`),
    'fn2 is not packaged in function hello6'
  );
  t.false(
    zipfiles_hello6.includes(`dataclasses.py`),
    'dataclasses is packaged in function hello6'
  );
  t.false(
    zipfiles_hello6.includes(`flask${sep}__init__.py`),
    'flask is not packaged in function hello6'
  );
  t.true(
    zipfiles_hello6.includes(`common${sep}__init__.py`),
    'module common is packaged in function hello6'
  );

  t.end();
});

test('can package individually without moving modules to root of zip-File with option useStaticCache=true', t => {
  process.chdir('tests/base');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  sls([
    '--individually=true',
    '--moveup=false',
    '--useStaticCache=true',
    'package'
  ]);

  const zipfiles_hello = listZipFiles('.serverless/hello.zip');
  t.false(
    zipfiles_hello.includes(`fn2${sep}__init__.py`),
    'fn2 is not packaged in function hello'
  );
  t.true(
    zipfiles_hello.includes('handler.py'),
    'handler.py is packaged in function hello'
  );
  t.false(
    zipfiles_hello.includes(`dataclasses.py`),
    'dataclasses is not packaged in function hello'
  );
  t.true(
    zipfiles_hello.includes(`flask${sep}__init__.py`),
    'flask is packaged in function hello'
  );

  const zipfiles_hello4 = listZipFiles('.serverless/hello4.zip');
  t.true(
    zipfiles_hello4.includes(`fn2${sep}__init__.py`),
    'fn2 is packaged as module in function hello4'
  );
  t.true(
    zipfiles_hello4.includes(`dataclasses.py`),
    'dataclasses is packaged in function hello4'
  );
  t.false(
    zipfiles_hello4.includes(`flask${sep}__init__.py`),
    'flask is not packaged in function hello4'
  );
  t.false(
    zipfiles_hello4.includes(`common${sep}__init__.py`),
    'module common is not packaged in function hello4'
  );

  const zipfiles_hello5 = listZipFiles('.serverless/hello5.zip');
  t.true(
    zipfiles_hello5.includes(`fn2${sep}__init__.py`),
    'fn2 is packaged as module in function hello5'
  );
  t.true(
    zipfiles_hello5.includes(`dataclasses.py`),
    'dataclasses is packaged in function hello5'
  );
  t.false(
    zipfiles_hello5.includes(`flask${sep}__init__.py`),
    'flask is not packaged in function hello5'
  );
  t.true(
    zipfiles_hello5.includes(`common${sep}__init__.py`),
    'module common is packaged in function hello5'
  );

  const zipfiles_hello6 = listZipFiles('.serverless/hello6.zip');
  t.true(
    zipfiles_hello6.includes(`fn3${sep}__init__.py`),
    'fn3 is packaged as module in function hello6'
  );
  t.false(
    zipfiles_hello6.includes(`fn2${sep}__init__.py`),
    'fn2 is not packaged in function hello6'
  );
  t.false(
    zipfiles_hello6.includes(`dataclasses.py`),
    'dataclasses is packaged in function hello6'
  );
  t.false(
    zipfiles_hello6.includes(`flask${sep}__init__.py`),
    'flask is not packaged in function hello6'
  );
  t.true(
    zipfiles_hello6.includes(`common${sep}__init__.py`),
    'module common is packaged in function hello6'
  );

  t.end();
});

test('can package individually without moving modules to root of zip-File with useStaticCache=true and useDownloadCache=true', t => {
  process.chdir('tests/base');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  sls([
    '--individually=true',
    '--moveup=false',
    '--useStaticCache=true',
    '--useDownloadCache=true',
    'package'
  ]);

  const zipfiles_hello = listZipFiles('.serverless/hello.zip');
  t.false(
    zipfiles_hello.includes(`fn2${sep}__init__.py`),
    'fn2 is not packaged in function hello'
  );
  t.true(
    zipfiles_hello.includes('handler.py'),
    'handler.py is packaged in function hello'
  );
  t.false(
    zipfiles_hello.includes(`dataclasses.py`),
    'dataclasses is not packaged in function hello'
  );
  t.true(
    zipfiles_hello.includes(`flask${sep}__init__.py`),
    'flask is packaged in function hello'
  );

  const zipfiles_hello4 = listZipFiles('.serverless/hello4.zip');
  t.true(
    zipfiles_hello4.includes(`fn2${sep}__init__.py`),
    'fn2 is packaged as module in function hello4'
  );
  t.true(
    zipfiles_hello4.includes(`dataclasses.py`),
    'dataclasses is packaged in function hello4'
  );
  t.false(
    zipfiles_hello4.includes(`flask${sep}__init__.py`),
    'flask is not packaged in function hello4'
  );
  t.false(
    zipfiles_hello4.includes(`common${sep}__init__.py`),
    'module common is not packaged in function hello4'
  );

  const zipfiles_hello5 = listZipFiles('.serverless/hello5.zip');
  t.true(
    zipfiles_hello5.includes(`fn2${sep}__init__.py`),
    'fn2 is packaged as module in function hello5'
  );
  t.true(
    zipfiles_hello5.includes(`dataclasses.py`),
    'dataclasses is packaged in function hello5'
  );
  t.false(
    zipfiles_hello5.includes(`flask${sep}__init__.py`),
    'flask is not packaged in function hello5'
  );
  t.true(
    zipfiles_hello5.includes(`common${sep}__init__.py`),
    'module common is packaged in function hello5'
  );

  const zipfiles_hello6 = listZipFiles('.serverless/hello6.zip');
  t.true(
    zipfiles_hello6.includes(`fn3${sep}__init__.py`),
    'fn3 is packaged as module in function hello6'
  );
  t.false(
    zipfiles_hello6.includes(`fn2${sep}__init__.py`),
    'fn2 is not packaged in function hello6'
  );
  t.false(
    zipfiles_hello6.includes(`dataclasses.py`),
    'dataclasses is packaged in function hello6'
  );
  t.false(
    zipfiles_hello6.includes(`flask${sep}__init__.py`),
    'flask is not packaged in function hello6'
  );
  t.true(
    zipfiles_hello6.includes(`common${sep}__init__.py`),
    'module common is packaged in function hello6'
  );

  t.end();
});

test('can package individually, moving modules to root of zip-File with IndividuallyMoveUpModules=true', t => {
  process.chdir('tests/base');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  sls(['--individually=true', '--moveup=true', 'package']);

  const zipfiles_hello = listZipFiles(
    '.serverless/root-sls-py-req-test-dev-hello.zip'
  );
  t.false(
    zipfiles_hello.includes(`fn2${sep}__init__.py`),
    'fn2 is not packaged in function hello'
  );
  t.true(
    zipfiles_hello.includes('handler.py'),
    'handler.py is packaged in function hello'
  );
  t.false(
    zipfiles_hello.includes(`dataclasses.py`),
    'dataclasses is not packaged in function hello'
  );
  t.true(
    zipfiles_hello.includes(`flask${sep}__init__.py`),
    'flask is packaged in function hello'
  );

  const zipfiles_hello4 = listZipFiles(
    '.serverless/fn2-sls-py-req-test-dev-hello4.zip'
  );
  t.true(
    zipfiles_hello4.includes(`other.py`),
    'fn2 is moved to root in function hello4'
  );
  t.true(
    zipfiles_hello4.includes(`dataclasses.py`),
    'dataclasses is packaged in function hello4'
  );
  t.false(
    zipfiles_hello4.includes(`flask${sep}__init__.py`),
    'flask is not packaged in function hello4'
  );
  t.false(
    zipfiles_hello4.includes(`common${sep}__init__.py`),
    'module common is not packaged in function hello4'
  );

  const zipfiles_hello5 = listZipFiles(
    '.serverless/fn2-sls-py-req-test-dev-hello5.zip'
  );
  t.true(
    zipfiles_hello5.includes(`other.py`),
    'fn2 is moved to root in function hello5'
  );
  t.true(
    zipfiles_hello5.includes(`dataclasses.py`),
    'dataclasses is packaged in function hello5'
  );
  t.false(
    zipfiles_hello5.includes(`flask${sep}__init__.py`),
    'flask is not packaged in function hello5'
  );
  t.true(
    zipfiles_hello5.includes(`common${sep}__init__.py`),
    'module common is packaged in function hello5'
  );

  const zipfiles_hello6 = listZipFiles(
    '.serverless/fn3-sls-py-req-test-dev-hello6.zip'
  );
  t.true(
    zipfiles_hello6.includes(`fn3_handler.py`),
    'fn3 is moved to root in function  hello6'
  );
  t.false(
    zipfiles_hello6.includes(`fn2${sep}__init__.py`),
    'fn2 is not packaged in function hello6'
  );
  t.false(
    zipfiles_hello6.includes(`dataclasses.py`),
    'dataclasses is packaged in function hello6'
  );
  t.false(
    zipfiles_hello6.includes(`flask${sep}__init__.py`),
    'flask is not packaged in function hello6'
  );
  t.true(
    zipfiles_hello6.includes(`common${sep}__init__.py`),
    'module common is packaged in function hello6'
  );

  t.end();
});

test('py3.6 uses download cache with useDownloadCache option', t => {
  process.chdir('tests/base');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  sls(['--useDownloadCache=true', 'package']);

  const cachepath = getUserCachePath()
  t.true(
    pathExistsSync(`${cachepath}${sep}downloadCacheslspyc${sep}http`),
    'cache directoy exists'
  );

  t.end();
});

test('py3.6 uses download cache with cacheLocation option', t => {
  process.chdir('tests/base');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  sls(['--useDownloadCache=true', '--cacheLocation=.requirements-cache', 'package']);

  t.true(
    pathExistsSync(`.requirements-cache${sep}downloadCacheslspyc${sep}http`),
    'cache directoy exists'
  );

  t.end();
});


/*
 * News tests not in test.bats
 */

test("py3.6 doesn't package bottle with zip option", t => {
  process.chdir('tests/base');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  perl([
    '-p',
    "-i'.bak'",
    '-e',
    's/(pythonRequirements:$)/\\1\\n    noDeploy: [bottle]/',
    'serverless.yml'
  ]);
  sls([`--pythonBin=${getPythonBin(3)}`, '--zip=true', 'package']);
  const zipfiles = listZipFiles('.serverless/sls-py-req-test.zip');
  const zippedReqs = listRequirementsZipFiles(
    '.serverless/sls-py-req-test.zip'
  );
  t.true(
    zipfiles.includes('.requirements.zip'),
    'zipped requirements are packaged'
  );
  t.true(zipfiles.includes(`unzip_requirements.py`), 'unzip util is packaged');
  t.false(
    zipfiles.includes(`flask${sep}__init__.py`),
    "flask isn't packaged on its own"
  );
  t.true(
    zippedReqs.includes(`flask/__init__.py`),
    'flask is packaged in the .requirements.zip file'
  );
  t.false(
    zippedReqs.includes(`bottle.py`),
    'bottle is not packaged in the .requirements.zip file'
  );
  t.end();
});

test('py3.6 can package flask with slim, slimPatterns & slimPatternsAppendDefaults=false options', t => {
  process.chdir('tests/base');
  copySync('_slimPatterns.yml', 'slimPatterns.yml');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  sls(['--slim=true', '--slimPatternsAppendDefaults=false', 'package']);

  const zipfiles = listZipFiles('.serverless/sls-py-req-test.zip');
  t.true(zipfiles.includes(`flask${sep}__init__.py`), 'flask is packaged');
  t.true(
    zipfiles.filter(filename => filename.endsWith('.pyc')).length >= 1,
    'pyc files are packaged'
  );
  t.deepEqual(
    zipfiles.filter(filename => filename.includes('.egg-info')),
    [],
    '.egg-info folders are not packaged'
  );
  t.end();
});

test(
  'py3.6 can package flask with slim & dockerizePip & slimPatterns & slimPatternsAppendDefaults=false options',
  t => {
    process.chdir('tests/base');
    copySync('_slimPatterns.yml', 'slimPatterns.yml');
    const path = npm(['pack', '../..']);
    npm(['i', path]);
    sls([
      '--dockerizePip=true',
      '--slim=true',
      '--slimPatternsAppendDefaults=false',
      'package'
    ]);

    const zipfiles = listZipFiles('.serverless/sls-py-req-test.zip');
    t.true(zipfiles.includes(`flask${sep}__init__.py`), 'flask is packaged');
    t.true(
      zipfiles.filter(filename => filename.endsWith('.pyc')).length >= 1,
      'pyc files are packaged'
    );
    t.deepEqual(
      zipfiles.filter(filename => filename.includes('.egg-infooo')),
      [],
      '.egg-info folders are not packaged'
    );
    t.end();
  },
  { skip: !canUseDocker() }
);

test('py2.7 can package flask with slim & slimPatterns & slimPatternsAppendDefaults=false options', t => {
  process.chdir('tests/base');
  copySync('_slimPatterns.yml', 'slimPatterns.yml');
  const path = npm(['pack', '../..']);
  npm(['i', path]);
  sls([
    '--runtime=python2.7',
    '--slim=true',
    '--slimPatternsAppendDefaults=false',
    'package'
  ]);

  const zipfiles = listZipFiles('.serverless/sls-py-req-test.zip');
  t.true(zipfiles.includes(`flask${sep}__init__.py`), 'flask is packaged');
  t.true(
    zipfiles.filter(filename => filename.endsWith('.pyc')).length >= 1,
    'pyc files are packaged'
  );
  t.deepEqual(
    zipfiles.filter(filename => filename.includes('.egg-info')),
    [],
    '.egg-info folders are not packaged'
  );
  t.end();
});

test(
  'py2.7 can package flask with slim & dockerizePip & slimPatterns & slimPatternsAppendDefaults=false options',
  t => {
    process.chdir('tests/base');
    copySync('_slimPatterns.yml', 'slimPatterns.yml');
    const path = npm(['pack', '../..']);
    npm(['i', path]);
    sls([
      '--dockerizePip=true',
      '--runtime=python2.7',
      '--slim=true',
      '--slimPatternsAppendDefaults=false',
      'package'
    ]);
    const zipfiles = listZipFiles('.serverless/sls-py-req-test.zip');
    t.true(zipfiles.includes(`flask${sep}__init__.py`), 'flask is packaged');
    t.true(
      zipfiles.filter(filename => filename.endsWith('.pyc')).length >= 1,
      'pyc files are packaged'
    );
    t.deepEqual(
      zipfiles.filter(filename => filename.includes('.egg-info')),
      [],
      '.egg-info folders are not packaged'
    );
    t.end();
  },
  { skip: !canUseDocker() }
);

test('pipenv py3.6 can package flask with slim & slimPatterns & slimPatternsAppendDefaults=false  option', t => {
  process.chdir('tests/pipenv');
  copySync('_slimPatterns.yml', 'slimPatterns.yml');
  const path = npm(['pack', '../..']);
  npm(['i', path]);

  sls(['--slim=true', '--slimPatternsAppendDefaults=false', 'package']);
  const zipfiles = listZipFiles('.serverless/sls-py-req-test.zip');
  t.true(zipfiles.includes(`flask${sep}__init__.py`), 'flask is packaged');
  t.true(
    zipfiles.filter(filename => filename.endsWith('.pyc')).length >= 1,
    'pyc files are packaged'
  );
  t.deepEqual(
    zipfiles.filter(filename => filename.includes('.egg-info')),
    [],
    '.egg-info folders are not packaged'
  );
  t.end();
});
