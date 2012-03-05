// ==UserScript==
// @name           Free Mobile: authentification classique
// @version        0.0.40
// @namespace      https://github.com/g2p
// @author         Gabriel <g2p.code@gmail.com> https://github.com/g2p
// @description    Authentification Free Mobile sans clavier visuel
// @match          https://mobile.free.fr/moncompte/*
// @require  https://ajax.googleapis.com/ajax/libs/jquery/1.7.1/jquery.min.js
// @require  http://cloud.github.com/downloads/harthur/brain/brain-0.3.5.min.js
// @resource       ocrnet ocrnet.json
// ==/UserScript==

// this https -> http redirect isn't supported in scriptish
// @require  https://github.com/downloads/harthur/brain/brain-0.3.5.min.js
// @resource and @load aren't supported in chrome
// @run-at breaks form autocompletion, somehow

if ($('#ident_pos').length == 0)
    return; // XXX Not portable?

let log = console.log;

let FORM_DELAY_MILLIS = 4000;

let imgs = $('.pointer');
let img0 = imgs[0];
let width = img0.width;
let height = img0.height;
let cwidth = 10 * width;
let cheight = 2 * height;
let canvas = $('<canvas>').attr({height: cheight, width: cwidth});
let ctx = canvas[0].getContext('2d');

function initCanvas() {
    ctx.clearRect(0, 0, cwidth, height);
    imgs.each(function(idx, img) {
        // Not sure if drawImage will block on a download
        if (! img.complete)
            throw 'digit image not loaded at pos ' + idx;
        ctx.drawImage(img, idx * width, 0, width, height);
    });
}

function areCoordsInDigitBounds(x, y) {
    // 8×15, 120 pixels considered
    return (x >= 15 && x < 23 && y >= 12 && y < 27);
}

function intensityOfPixel(imgData, i) {
    let r = imgData.data[i * 4 + 0];
    let g = imgData.data[i * 4 + 1];
    let b = imgData.data[i * 4 + 2];
    let a = imgData.data[i * 4 + 3];

    if (1.5 * r > g + b) {
        return 1;
    } else {
        return 0;
    }
}

function filteredDigit(imgData, pos) {
    let sig = [];
    let sigpos = 0;
    for (let x = 15; x < 23; x++) {
        for (let y = 12; y < 27; y++) {
            let i = x + pos * width + y * cwidth;
            let v = intensityOfPixel(imgData, i);
            sig[sigpos++] = v;
        }
    }
    return sig;
}

function annotate() {
    let imgData = ctx.getImageData(0, 0, cwidth, height);
    let datalen = imgData.data.length / 4;
    // data is rgba, 0..256

    for (let i = 0; i < datalen; i++) {
        let cx = i % cwidth;
        let x = cx % width;
        let y = i / cwidth;

        let v1 = (1 - intensityOfPixel(imgData, i)) * 255;
        let v2 = areCoordsInDigitBounds(x, y) ? 0 : 255;

        imgData.data[i * 4 + 0] = v2;
        imgData.data[i * 4 + 1] = v1;
        imgData.data[i * 4 + 2] = v1;
        imgData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imgData, 0, height);
}

function ocr() {
    initCanvas();
    let imgData = ctx.getImageData(0, 0, cwidth, height);

    let digits = [];
    let rdigits = [];

    let net = new brain.NeuralNetwork();
    let netJson;

    if (false) {
        // XXX localStorage doesn't always persist
        // OTOH GM_setValue takes up room in prefs.js
        netJson = localStorage.getItem('ocrnet');
    } else {
        // @resource declared in the metadata block
        netJson = GM_getResourceText('ocrnet');
    }
    net.fromJSON(JSON.parse(netJson));

    imgs.each(function(idx, img) {
        let out = net.run(filteredDigit(imgData, idx));
        let digit = -1;
        let highscore = -1;
        $.each(out, function(idx, score) {
            if (score > highscore) {
                digit = idx;
                highscore = score;
            }
        });
        digits.push(digit);
        rdigits[digit] = idx;
        //log('ret', idx, digit, out);
    });
    log('ocr done, rdigits: ', rdigits);
    return {digits: digits, rdigits: rdigits};
}

if (false) {
    $('<form><input value="ocr" type="submit">').submit(function() {
        log('will ocr');

        digits = ocr().digits;
        ctx.clearRect(0, 0, cwidth, height);
        imgs.each(function(idx, img) {
            ctx.drawImage(img, digits[idx] * width, 0, width, height);
        });
        annotate();

        log('ocr done');
        return false;
    }).appendTo('#ident_div_ident');

    $('<form><input><input value="train" type="submit">').submit(function() {
        log('will train');
        let digits = $('input:first', this).val();
        log('digits: ', digits);
        let imgData = ctx.getImageData(0, 0, cwidth, height);
        training = [];
        $.each(digits, function(idx, digit) {
            entry = {
                input: filteredDigit(imgData, idx),
                output: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
            };
            entry.output[parseInt(digit)] = 1.0;
            training[idx] = entry;
        });
        log('training on ', training);
        // 7 hidden neurons is enough;
        // the default of half the pixels is too high.
        let net = new brain.NeuralNetwork({hidden: [7]});
        net.train(training);
        netJson = JSON.stringify(net.toJSON());
        localStorage.setItem('ocrnet', netJson);
        log('ocrnet: ', netJson);
        log('trained');
        return false;
    }).appendTo('#ident_div_ident');

    canvas.appendTo($('#ident_div_ident'));
}

function fixForm() {
    let form = $('#ident_div_ident form');
    $('p:first, #ident_txt_identifiant, #btAideVocale, .ident_chiffre2', form).hide();
    $('<input type="text">')
        .attr({id: 'ident_login'}).insertAfter('#ident_pos');
    $(form).one('submit', function() {
        let rdigits = ocr().rdigits;
        let lgn = $('#ident_login').val();
        let encoded = '';
        let waiting = lgn.length;
        let waitingTime = true;
        let reqImgs = {};

        $('<span class="red">').text(
            'En attente de soumission…').insertAfter('.ident_chiffre2');

        setTimeout(function () {
            waitingTime = false;
            if (! waiting)
                form.submit();
        }, FORM_DELAY_MILLIS);

        $.each(lgn, function(idx, digit) {
            edigit = rdigits[digit];
            encoded += edigit;

            if (reqImgs[edigit]) {
                waiting--;
                return;
            }

            reqImgs[edigit] = true;
            $.ajax('chiffre.php?pos=' + digit + '&small=1').always(function() {
                waiting--;
                if (! waiting && ! waitingTime)
                    form.submit();
            });
        });
        $('#ident_pos').val(encoded);
        return false;
    });
}

fixForm();
log('ready');

