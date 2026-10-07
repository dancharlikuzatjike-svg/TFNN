// NamLITS "Herd Statement - Tagged List" reader.
//
// Turns the text of a NamLITS herd statement (the PDF printed from NamLITS Online)
// into TFNN animals. Works in the browser (window.NamlitsImport) and in Node (tests).
//
// What the statement looks like (one block per herd / animal type / class / breed):
//   HQ255453  OWNER NAME   Cattle  Cow    Brahman  Beef    11  54197330
//                                                                 64155070   <- one tag per line
//   ...
//   Sheep Group  *  Sheep  Mutton  40  O000695M   <- a group: one shared tag, head count 40
//
// Individually tagged animals keep their real tag. A group that has a single shared tag
// and a head count above 1 is expanded into numbered animals (TAG-01, TAG-02, ...), because
// TFNN needs a unique tag per animal. Those can be renamed once the animals are tagged.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NamlitsImport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SPECIES = ['Cattle', 'Sheep', 'Goat'];
  var CLASS_OPTIONS = {
    Cattle: ['Cow', 'Bull', 'Heifer', 'Steer', 'Calf'],
    Sheep: ['Ewe', 'Ram', 'Wether', 'Lamb'],
    Goat: ['Doe', 'Buck', 'Wether', 'Kid'],
  };
  var TAG_RE = /^[A-Za-z0-9][A-Za-z0-9\-_/.]{3,}$/; // 4+ chars, letters/digits
  var INT_RE = /^\d+$/;

  // Rebuild text lines from PDF text items ({ str, x, y }), so the parser can read a
  // PDF straight from the browser. Items on (almost) the same height become one line.
  function linesFromItems(items, tolerance) {
    tolerance = tolerance || 3;
    var rows = [];
    items
      .filter(function (it) { return it && String(it.str).trim() !== ''; })
      .sort(function (a, b) { return b.y - a.y || a.x - b.x; })
      .forEach(function (it) {
        var row = rows.length ? rows[rows.length - 1] : null;
        if (row && Math.abs(row.y - it.y) <= tolerance) row.items.push(it);
        else rows.push({ y: it.y, items: [it] });
      });
    return rows.map(function (row) {
      return row.items
        .sort(function (a, b) { return a.x - b.x; })
        .map(function (it) { return String(it.str).trim(); })
        .join(' ');
    });
  }

  function tidyBreed(breed) {
    // NamLITS cuts long names off ("Beef Crossbr"); restore the obvious one.
    return breed.replace(/\bCrossbr\b/i, 'Crossbred').replace(/\s+/g, ' ').trim();
  }

  function parse(text) {
    var out = {
      keeper: null,
      establishment: null,
      herds: [],        // each: { species, class, breed, production, headCount, tags, isGroup }
      grandTotal: null,
      warnings: [],
    };
    var current = null;
    var lines = String(text).split(/\r?\n/);

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].replace(/\s+/g, ' ').trim();
      if (!line) continue;

      var m;
      if ((m = line.match(/^Selection:\s*Establishment:\s*(.+)$/i)) || (m = line.match(/^Establishment:\s*(.+)$/i))) {
        out.establishment = m[1].trim();
        continue;
      }
      if ((m = line.match(/^Livestock Keeper:\s*(.+)$/i))) { out.keeper = m[1].trim(); continue; }
      if ((m = line.match(/^Grand Total:\s*(\d+)/i))) { out.grandTotal = Number(m[1]); current = null; continue; }
      if (/^Animal Total:/i.test(line)) { current = null; continue; }
      if (/^(Herd Statement|Herd Owner Name|Total number of rows|\*+ END OF REPORT|Printed:)/i.test(line)) continue;

      var tokens = line.split(' ');

      // A line that is just a tag: another animal of the current block
      if (tokens.length === 1 && TAG_RE.test(tokens[0]) && current) {
        current.tags.push(tokens[0]);
        continue;
      }

      var si = -1;
      for (var t = 0; t < tokens.length; t++) {
        if (SPECIES.indexOf(tokens[t]) !== -1) { si = t; break; }
      }
      if (si === -1) continue; // not a data line (titles, page numbers, ...)

      var rest = tokens.slice(si);
      var tag = null;
      var count = null;
      var last = rest[rest.length - 1];
      var prev = rest[rest.length - 2];
      if (rest.length >= 3 && TAG_RE.test(last) && INT_RE.test(prev)) {
        tag = last; count = Number(prev); rest = rest.slice(0, -2);
      } else if (rest.length >= 2 && INT_RE.test(last) && !INT_RE.test(prev)) {
        count = Number(last); rest = rest.slice(0, -1);
      } else {
        out.warnings.push('Could not read this line: "' + line + '"');
        current = null;
        continue;
      }

      var species = rest[0];
      var production = rest.length > 1 ? rest[rest.length - 1] : '';
      var mid = rest.slice(1, rest.length > 1 ? -1 : undefined);
      var isGroup = false;
      if (mid[0] && mid[0].toLowerCase() === 'group') { isGroup = true; mid = mid.slice(1); }

      var cls = null;
      if (mid[0] === '*') { mid = mid.slice(1); }
      else if (mid[0] && CLASS_OPTIONS[species].indexOf(mid[0]) !== -1) { cls = mid[0]; mid = mid.slice(1); }
      else if (mid[0] && !isGroup) {
        out.warnings.push('Class "' + mid[0] + '" is not one TFNN uses for ' + species.toLowerCase() + ', so it was left blank.');
        mid = mid.slice(1);
      }

      var breed = tidyBreed(mid.join(' '));
      if (!breed || breed.toLowerCase() === species.toLowerCase() || breed === '*') breed = null;

      current = {
        species: species,
        class: cls,
        breed: breed,
        production: production,
        headCount: count,
        isGroup: isGroup,
        tags: tag ? [tag] : [],
      };
      out.herds.push(current);
    }

    return out;
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  // Turn the parsed statement into the animals TFNN should create.
  function toAnimals(parsed) {
    var animals = [];
    var warnings = parsed.warnings.slice();
    var seen = {};

    parsed.herds.forEach(function (h) {
      var label = (h.breed ? h.breed + ' ' : '') + h.species.toLowerCase() + (h.class ? ' (' + h.class.toLowerCase() + ')' : '');
      var tags;
      if (h.tags.length === h.headCount) {
        tags = h.tags;
      } else if (h.tags.length === 1 && h.headCount > 1) {
        // Sheep and goats on one statement often share the same tag, so the species
        // letter keeps their numbers apart (O000111M-S01 for sheep, O000111M-G01 for goats).
        var width = Math.max(2, String(h.headCount).length);
        var letter = h.species.charAt(0);
        tags = [];
        for (var i = 1; i <= h.headCount; i++) tags.push(h.tags[0] + '-' + letter + pad(i, width));
        warnings.push(h.headCount + ' ' + label + ' share the tag ' + h.tags[0] +
          ', so they are numbered ' + tags[0] + ' to ' + tags[tags.length - 1] + '.');
      } else if (h.tags.length === 0) {
        warnings.push('No tags found for ' + h.headCount + ' ' + label + ' - skipped.');
        return;
      } else {
        tags = h.tags;
        warnings.push('The statement says ' + h.headCount + ' ' + label + ' but lists ' + h.tags.length + ' tags. Only the listed tags are imported.');
      }

      tags.forEach(function (tag) {
        if (seen[tag]) { warnings.push('Tag ' + tag + ' appears twice - only the first is imported.'); return; }
        seen[tag] = true;
        animals.push({
          tag_number: tag,
          species: h.species,
          breed: h.breed || undefined,
          class: h.class || undefined,
          numbered: h.tags.length === 1 && h.headCount > 1,
        });
      });
    });

    var total = parsed.herds.reduce(function (sum, h) { return sum + h.headCount; }, 0);
    var totalMatches = parsed.grandTotal == null ? null : (parsed.grandTotal === total && animals.length === total);
    if (parsed.grandTotal != null && parsed.grandTotal !== total) {
      warnings.push('The statement total is ' + parsed.grandTotal + ' but the rows add up to ' + total + '. Check the preview before importing.');
    }
    return { animals: animals, warnings: warnings, total: total, totalMatches: totalMatches };
  }

  function looksLikeNamlits(text) {
    return /Herd Statement/i.test(text) || /NamLITS/i.test(text) || /Livestock Keeper:/i.test(text);
  }

  return { parse: parse, toAnimals: toAnimals, linesFromItems: linesFromItems, looksLikeNamlits: looksLikeNamlits };
});
