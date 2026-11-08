// Runs ELK (Eclipse Layout Kernel, layered + orthogonal routing) on graph.json -> laid.json
const ELK = require('elkjs');
const fs = require('fs');
const [, , inF, outF] = process.argv;
new ELK()
  .layout(JSON.parse(fs.readFileSync(inF, 'utf8')))
  .then((g) => fs.writeFileSync(outF, JSON.stringify(g)))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
