// Change only the loaded test process; leave the user's source file untouched.
const fs = require('node:fs');
const Module = require('node:module');
const original = Module._extensions['.js'];
Module._extensions['.js'] = function(mod, filename) {
  if (filename.replaceAll('\\', '/').endsWith('/miniprogram/services/mock.js')) {
    return mod._compile(fs.readFileSync(filename, 'utf8').replace("const DEFAULT_CURRENT_USER_ID = 'u01';", "const DEFAULT_CURRENT_USER_ID = 'u06';"), filename);
  }
  return original(mod, filename);
};
