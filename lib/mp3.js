/*global module,require,process,Buffer*/

"use strict";

const { Writable } = require("stream");

// code mostly lifted from https://github.com/spreaker/node-mp3-header/blob/master/src/Mp3Header.js
// MIT licensed

/**
 * Bitrates table:
 * the bitrate value is calculated based on the mpeg version and layer
 */
const BITRATES = {
    1: {
        1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1],
        2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, -1],
        3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
        4: [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]
    },
    2: {
        1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, -1],
        2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
        3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
        4: [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]
    }
};

/**
 * Sample rate table:
 * the sample rate value is calculated based on the mpeg version
 */
const SAMPLE_RATES = {
    1: [44100, 48000, 32000, -1],
    2: [22050, 24000, 16000, -1]
};

/**
 * Samples per frame table:
 * the number of samples per frame is calculated based on the mpeg version and layer
 */
const SAMPLES_PER_FRAME = {
    1: {0: 0, 1: 384, 2: 1152, 3: 1152},
    2: {0: 0, 1: 384, 2: 1152, 3: 576}
};

class Mp3Parser extends Writable {
    constructor(options) {
        super(options);

        this._chunks = [];
        this._offset = 0;
        this._where = 0;
        this._done = false;
        this._id3v2 = false;
    }

    _write(chunk, encoding, done) {
        this._chunks.push(chunk);
        process.nextTick(done);

        this._parse();
    }

    _final(done) {
        process.nextTick(done);

        this._done = true;
        this._parse();
    }

    _readBytes(bytes, offset) {
        if (!bytes)
            return undefined;
        // skip to offset
        let readOffset = this._offset;
        // console.log("read offset", readOffset);
        let bufidx = 0;
        while (offset) {
            if (bufidx >= this._chunks.length)
                return undefined;
            const chunk = this._chunks[bufidx];
            const toskip = Math.min(offset, chunk.length - readOffset);
            offset -= toskip;
            if (toskip == chunk.length - readOffset) {
                ++bufidx;
                readOffset = 0;
            } else {
                readOffset += toskip;
            }
        }
        let ret = new Buffer(bytes);
        let writeOffset = 0;
        // read bytes
        while (bytes) {
            if (bufidx >= this._chunks.length)
                return undefined;
            const chunk = this._chunks[bufidx];
            const toread = Math.min(bytes, chunk.length - readOffset);
            //console.log("ikke forstaa", writeOffset, readOffset, toread);
            chunk.copy(ret, writeOffset, readOffset, readOffset + toread);
            writeOffset += toread;
            bytes -= toread;
            if (toread == chunk.length - readOffset) {
                ++bufidx;
                readOffset = 0;
            } else {
                readOffset += toread;
            }
        }
        return ret;
    }

    _skip(offset) {
        const start = offset;
        if (!offset)
            return true;
        let bufidx = 0, readOffset = this._offset;
        for (;;) {
            if (bufidx >= this._chunks.length) {
                return false;
            }
            const chunk = this._chunks[bufidx];
            const toskip = Math.min(offset, chunk.length - readOffset);
            offset -= toskip;
            if (toskip == chunk.length - readOffset) {
                ++bufidx;
                readOffset = 0;
            } else {
                readOffset += toskip;
            }
            if (!offset) {
                // done
                this._offset = readOffset;
                if (bufidx > 0)
                    this._chunks.splice(0, bufidx);
                break;
            }
        }
        this._where += start;
        return true;
    }

    _parse() {
        let buffer;
        if (!this._id3v2) {
            // check if we have an id3v2 header
            buffer = this._readBytes(10);
            if (buffer) {
                // ID3
                if (buffer[0] == 0x49 && buffer[1] == 0x44 && buffer[2] == 0x33) {
                    const length = (buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9];
                    if (this._skip(10 + length)) {
                        this._id3v2 = true;
                    } else {
                        return;
                    }
                } else {
                    this._id3v2 = true;
                }
            } else {
                return;
            }
        }

        let idx = 0;
        for (;;) {
            buffer = this._readBytes(4, 0);
            if (!buffer) {
                // console.error("no bytes");
                if (this._done)
                    this.emit("streamEnd");
                return;
            }

            // Not enough data to read the header
            if (buffer.length < 4) {
                //console.error("invalid buffer length");
                return;
            }

            // Read the first 4 bytes
            const header = [buffer.readUInt8(0), buffer.readUInt8(1), buffer.readUInt8(2), buffer.readUInt8(3)];

            // console.log(header);
            const is_valid = this._isMpegHeader(header);
            if (!is_valid) {
                //console.error("not valid");
                this._skip(1);
                continue;
            }

            const mpeg_version       = this._getMpegVersion(header[1] >> 3);
            if (!mpeg_version) {
                // bad
                this._skip(1);
                continue;
            }
            const mpeg_layer         = this._getMpegLayer(header[1] >> 1);
            if (!mpeg_layer) {
                // bad
                this._skip(1);
                continue;
            }

            const mpeg_bitrate       = this._getMpegBitrate(mpeg_version, mpeg_layer, header[2] >> 4);
            if (mpeg_bitrate == -1) {
                // bad
                this._skip(1);
                continue;
            }

            const mpeg_has_padding   = (header[2] & 0x02) >> 1 == 0x01;
            const mpeg_samplerate    = this._getMpegSampleRate(mpeg_version, header[2] >> 2);
            if (mpeg_samplerate == -1) {
                // bad
                this._skip(1);
                continue;
            }
            const mpeg_channels      = this._getMpegChannels(header[3] >> 6);
            const mpeg_num_samples   = this._getMpegNumSamples(mpeg_version, mpeg_layer);
            const mpeg_frame_length  = this._getMpegFrameLength(
                mpeg_has_padding,
                mpeg_samplerate,
                mpeg_layer,
                mpeg_bitrate,
                mpeg_num_samples
            );
            if (!mpeg_frame_length) {
                // bad
                this._skip(1);
                continue;
            }

            let where = this._where;
            // verify that we have a valid frame after this frame
            const nextBuffer = this._readBytes(4, mpeg_frame_length);
            if (!nextBuffer && !this._done) {
                // no next header yet
                break;
            }
            if (nextBuffer) {
                const nextHeader = [nextBuffer.readUInt8(0), nextBuffer.readUInt8(1), nextBuffer.readUInt8(2), nextBuffer.readUInt8(3)];

                const nextIsValid = this._isMpegHeader(nextHeader);
                if (!nextIsValid) {
                    this._skip(1);
                    continue;
                }
                this._skip(mpeg_frame_length);
            }

            const seconds = mpeg_num_samples / mpeg_samplerate;

            const out = {
                header: header,
                mpeg_version: mpeg_version,
                mpeg_layer: mpeg_layer,
                mpeg_has_padding: mpeg_has_padding,
                mpeg_channels: mpeg_channels,
                mpeg_bitrate: mpeg_bitrate,
                mpeg_samplerate: mpeg_samplerate,
                mpeg_num_samples: mpeg_num_samples,
                mpeg_frame_length: mpeg_frame_length,
                stream_offset: where,
                seconds: seconds
            };
            this.emit("streamHeader", out);

            if (!nextBuffer && this._done) {
                this.emit("streamEnd");
                break;
            }
        }

        //process.exit(0);
    }

    _isMpegHeader(header) {
        //return (((header[0] & 0xFF) << 8)  | ((header[1] & 0xF0))) == 0xFFF0;
        return (header[0] == 0xff && header[1] >= 0xe0);
    }

    _getMpegVersion(num) {

        /*
          00 - MPEG Version 2.5 (unofficial)
          01 - reserved
          10 - MPEG Version 2 (ISO/IEC 13818-3)
          11 - MPEG Version 1 (ISO/IEC 11172-3)
        */

        if ((num & 0x03) == 0x03) {
            return 1;
        }

        if ((num & 0x02) == 0x02) {
            return 2;
        }

        return 0;
    }

    _getMpegLayer(num) {

        /**
           00 - reserved
           01 - Layer III
           10 - Layer II
           11 - Layer I
        */

        if ((num & 0x03) == 0x03) {
            return 1;
        }

        if ((num & 0x02) == 0x02) {
            return 2;
        }

        if ((num & 0x01) == 0x01) {
            return 3;
        }

        return 0;
    }

    _getMpegChannels(num) {

        /*
          00 - Stereo
          01 - Joint stereo (Stereo)
          10 - Dual channel (2 mono channels)
          11 - Single channel (Mono)
        */

        if ((num & 0x03) == 0x03) {
            return 1;
        }

        return 2;
    }

    _getMpegBitrate(version, layer, num) {

        return BITRATES[version][layer][num & 0x0F] * 1000;
    }

    _getMpegSampleRate(version,  num) {

        return SAMPLE_RATES[version][num & 0x03];
    }

    _getMpegNumSamples(version, layer) {

        return SAMPLES_PER_FRAME[version][layer];
    }

    _getMpegFrameLength(has_padding, sample_rate, layer, bitrate, num_samples) {

        var padding = has_padding ? 1 : 0;
        if (sample_rate == 0) {
            return 0;
        }

        if (layer == 1) {
            return Math.floor(12.0 * bitrate / sample_rate + padding) * 4;
        }

        return Math.floor(num_samples * (bitrate / 8) / sample_rate) + padding;
    }
}

module.exports = Mp3Parser;
