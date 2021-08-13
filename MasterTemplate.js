// version 0.0.1
// https://github.com/WebReflection/backtick-template
// https://stackoverflow.com/questions/29182244/convert-a-string-to-a-template-string
var replace = ''.replace;

var ca = /[&<>'"]/g;
var es = /&(?:amp|#38|lt|#60|gt|#62|apos|#39|quot|#34);/g;

var esca = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;'
};
var unes = {
  '&amp;': '&',
  '&#38;': '&',
  '&lt;': '<',
  '&#60;': '<',
  '&gt;': '>',
  '&#62;': '>',
  '&apos;': "'",
  '&#39;': "'",
  '&quot;': '"',
  '&#34;': '"'
};

class MasterTemplate{

  _ = {};
  $ = 0;


  /*! (C) 2017-2018 Andrea Giammarchi - MIT Style License */
  htmlBuilder( fn, $str, $object) {'use strict';
// reset cache every 32M
if (33554432 < this.$) {
  this._ = {};
  this.$ = 0;
}
var
  hasTransformer = typeof fn === 'function',
  str = hasTransformer ? $str : fn,
  object = hasTransformer ? $object : $str,
  _ = this._,
  known = _.hasOwnProperty(str),
  parsed = known ? _[str] : (_[str] = this.parse(str)),
  chunks = parsed.chunks,
  values = parsed.values,
  strings
;
// add str length only if not known
if (!known)
  this.$ += str.length;
if (hasTransformer) {
  str = 'function' + (Math.random() * 1e5 | 0);
  strings = [
    str,
    'with(this)return ' + str + '([' + chunks + ']' + (
      values.length ? (',' + values.join(',')) : ''
    ) + ')'
  ];
} else {
  strings = chunks.slice(0, 1);
  for (var i = 1, length = chunks.length; i < length; i++)
    strings.push(values[i - 1], chunks[i]);
  strings = ['with(this)return ' + strings.join('+')];
}
return Function.apply(null, strings).apply(
  object,
  hasTransformer ? [fn] : []
);
}

parse(str) {
var
  stringify = JSON.stringify,
  open = 0, close = 0, counter = 0,
  i = 0, length = str.length,
  chunks = i < length ? [] : ['""'],
  values = []
;
while (i < length) {
  open = str.indexOf('${', i);
  if (-1 < open) {
    chunks.push(stringify(str.slice(i, open)));
    open += 2;
    close = open;
    counter = 1;
    while (close < length) {
      switch (str.charAt(close++)) {
        case '}': --counter; break;
        case '{': ++counter; break;
      }
      if (counter < 1) {
        values.push('(' + str.slice(open, close - 1) + ')');
        break;
      }
    }
    i = close;
  } else {
    chunks.push(stringify(str.slice(i)));
    i = length;
  }
}
if (chunks.length === values.length)
  chunks.push('""');
return {chunks: chunks, values: values};
};
    
    escape(es) {
        return replace.call(es, ca, this.pe);
    }

    unescape(un) {
    return replace.call(un, es, this.cape);
    }

    pe(m) {
    return esca[m];
    }

    cape(m) {
    return unes[m];
    }
}

module.exports = new MasterTemplate();