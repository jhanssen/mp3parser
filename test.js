/*global require,process*/

const Mp3Parser = require("./lib/mp3");
const fs = require("fs");

const read = fs.createReadStream("./test.mp3");
const parser = new Mp3Parser();

let seconds = 0;

parser.on("streamHeader", header => {
    console.log("header", header);
    seconds += header.seconds;
});
parser.on("streamEnd", () => {
    console.log("end", seconds);
    process.exit();
});

read.pipe(parser);
