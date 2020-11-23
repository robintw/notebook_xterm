var MAX_POLL_INTERVAL = 1500;
var MIN_POLL_INTERVAL = 100;
var BACKOFF_RATE = 1.8;
var PY_XTERM_INSTANCE = 'get_ipython().find_magic("xterm").__self__';
var PY_TERMINAL_SERVER = PY_XTERM_INSTANCE + '.getTerminalServer()';

// From https://stackoverflow.com/questions/30106476/using-javascripts-atob-to-decode-base64-doesnt-properly-decode-utf-8-strings
var clz32 = Math.clz32 || (function (log, LN2) {
    "use strict";
    return function (x) {
        return 31 - log(x >>> 0) / LN2 | 0
    };
})(Math.log, Math.LN2);
var fromCharCode = String.fromCharCode;
var atobUTF8 = (function (atob, replacer) {
    "use strict";
    return function (inputString, keepBOM) {
        inputString = atob(inputString);
        if (!keepBOM && inputString.substring(0, 3) === "\xEF\xBB\xBF")
            inputString = inputString.substring(3); // eradicate UTF-8 BOM
        // 0xc0 => 0b11000000; 0xff => 0b11111111; 0xc0-0xff => 0b11xxxxxx
        // 0x80 => 0b10000000; 0xbf => 0b10111111; 0x80-0xbf => 0b10xxxxxx
        return inputString.replace(/[\xc0-\xff][\x80-\xbf]*/g, replacer);
    }
})(atob, function (encoded) {
    "use strict";
    var codePoint = encoded.charCodeAt(0) << 24;
    var leadingOnes = clz32(~codePoint);
    var endPos = 0,
        stringLen = encoded.length;
    var result = "";
    if (leadingOnes < 5 && stringLen >= leadingOnes) {
        codePoint = (codePoint << leadingOnes) >>> (24 + leadingOnes);
        for (endPos = 1; endPos < leadingOnes; ++endPos)
            codePoint = (codePoint << 6) | (encoded.charCodeAt(endPos) & 0x3f /*0b00111111*/ );
        if (codePoint <= 0xFFFF) { // BMP code point
            result += fromCharCode(codePoint);
        } else if (codePoint <= 0x10FFFF) {
            // https://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
            codePoint -= 0x10000;
            result += fromCharCode(
                (codePoint >> 10) + 0xD800, // highSurrogate
                (codePoint & 0x3ff) + 0xDC00 // lowSurrogate
            );
        } else endPos = 0; // to fill it in with INVALIDs
    }
    for (; endPos < stringLen; ++endPos) result += "\ufffd"; // replacement character
    return result;
});


function TerminalClient(elem) {
    this.closed = false;
    // require xterm.js
    require.config({
      paths: {
          xterm: '//cdnjs.cloudflare.com/ajax/libs/xterm/2.9.2/xterm.min'
      }
    });

    require(['xterm'], function(Terminal) {
        this.div_id = elem.attr('id')
        var termArea = this.create_ui(elem);
        this.term = new Terminal({
            rows: 15,
            cols: 100
        });
        this.term.open(termArea[0]);

        this.term.on('data', function(data) {
            this.handle_transmit(data);
        }.bind(this));

        this.term.on('resize', function() {
            this.handle_resize()
        }.bind(this));

        // set title
        this.term.on('title', function(title) {
            this.handle_title(title);
        }.bind(this));

        this.termArea.on('remove', function(ev) {
            this.close();
        }.bind(this))

        // set the initial size correctly
        this.handle_resize();

        // reset the terminal
        this.server_exec(PY_TERMINAL_SERVER + '.transmit(b"' + btoa('\r\nreset\r\nclear\r') + '")');

        // start polling
        this.curPollInterval = MIN_POLL_INTERVAL;
        this.poll_server();
        console.log('Starting notebook_xterm.');

        this.server_exec(PY_TERMINAL_SERVER + '.initial_transmit()');

    }.bind(this));
}

TerminalClient.prototype.create_ui = function(elem) {
    var INITIAL_TITLE = 'notebook_xterm'
    // add xterm stylesheet for formatting
    var xtermCssUrl = 'https://cdnjs.cloudflare.com/ajax/libs/xterm/2.9.2/xterm.min.css'
    $('<link/>', {rel: 'stylesheet', href: xtermCssUrl}).appendTo('head');

    this.wrap = $('<div>').appendTo(elem);
    this.wrap.css({
        padding: 10,
        margin: 10,
        marginTop: 5,
        backgroundColor: 'black',
        borderRadius: 5
    });
    this.titleBar = $('<div>').appendTo(this.wrap);
    this.titleBar.css({
        color: '#AAA',
        margin: -10,
        marginBottom: 5,
        padding: 10,
        overflow: 'hidden',
        borderBottom: '1px solid #AAA'
    })
    this.titleText = $('<div>').html(INITIAL_TITLE).css({float: 'left'}).appendTo(this.titleBar);
    this.comIndicator = $('<div>').html('&middot;').css({float: 'left', marginLeft: 10}).hide().appendTo(this.titleBar);
    this.close_button = $('<div>').html('<a onclick="window.terminalClient.close()">close</a>').css({float: 'right'}).appendTo(this.titleBar);
    this.termArea = $('<div>').appendTo(this.wrap);
    return this.termArea;
}

TerminalClient.prototype.update_com_indicator = function() {
    this.comIndicator.show().fadeOut(400);
}

TerminalClient.prototype.server_exec = function(cmd) {
    if (this.closed) {
        return;
    }

    Jupyter.notebook.kernel.execute(cmd, {
        iopub: {
            output: function(data) {
                this.receive_data_callback(data)
            }.bind(this)
        }
    });
}

TerminalClient.prototype.poll_server = function() {
    if (this.closed) {
        return;
    }

    this.server_exec(PY_TERMINAL_SERVER + '.receive()');
    clearTimeout(this.termPollTimer);
    this.termPollTimer = setTimeout(function() {
        this.poll_server();
    }.bind(this), this.curPollInterval);
    // gradually back off the polling interval
    this.curPollInterval = Math.min(this.curPollInterval*BACKOFF_RATE, MAX_POLL_INTERVAL);

    this.check_for_close();
}
TerminalClient.prototype.receive_data_callback = function(data) {
    if (this.closed) {
        return;
    }

    try {
        var decoded = atobUTF8(data.content.text);
        this.term.write(decoded);
    }
    catch(e) {
        var message = "\u001b[31;1m~~~ notebook_xterm error ~~~\u001b[0m\r\n"
        if (data.content.ename && data.content.evalue) {
            message += data.content.ename + ": " + data.content.evalue + "\r\n";
            data.content.traceback.map(function(row){
                row = row.replace('\n', '\r\n')
                message += row + '\r\n';
            });
        } else {
            message += "See browser console for more details.\r\n";
        }
        console.log(data.content);
        console.error("%O", e)
        this.handle_title('error');
        this.term.write(message);    }
}
TerminalClient.prototype.handle_transmit = function(data) {
    // we've had interaction, so reset the timer for the next poll
    // to minPollInterval
    this.curPollInterval = MIN_POLL_INTERVAL;

    // transmit data to the server, but b64 encode it
    this.server_exec(PY_TERMINAL_SERVER + '.transmit(b"' + btoa(data) + '")');
}

TerminalClient.prototype.handle_resize = function() {
    this.server_exec(PY_TERMINAL_SERVER + '.update_window_size('+ this.term.rows + ', '+ this.term.cols + ')');
}

TerminalClient.prototype.handle_title = function(title) {
    this.titleText.html(title);
}
TerminalClient.prototype.check_for_close = function() {
    if (!this.termArea.length) {
        this.close();
    }
}
TerminalClient.prototype.close = function() {
    if (this.closed) {
        return;
    }
    this.closed = true;
    console.log('Closing notebook_xterm.');
    clearTimeout(this.termPollTimer);
    this.server_exec(PY_XTERM_INSTANCE + '.deleteTerminalServer()');
    $("#" + this.div_id).remove()
}
// create the TerminalClient instance (only once!)
if (window.terminalClient) {
    console.log('Closing from if term client')
    window.terminalClient.close()
    delete window.terminalClient;
}