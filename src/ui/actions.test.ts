// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { FOCUS_HOME, focusIfLost, focusOnMount, restoreFocus, tabbables, trapFocus } from './actions';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function tab(from: HTMLElement, shift = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
  from.dispatchEvent(e);
  return e;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('tabbables', () => {
  it('lists the stops in document order, leaving out what Tab skips', () => {
    document.body.innerHTML = `
      <div id="root">
        <h2 tabindex="-1">Title</h2>
        <button id="a">A</button>
        <button id="b" disabled>B</button>
        <button id="c" tabindex="-1">C</button>
        <input id="d" type="hidden">
        <input id="file" type="file" tabindex="-1">
        <div inert><button id="e">E</button></div>
        <div style="display: none"><button id="f">F</button></div>
        <a id="g">no address</a>
        <a id="h" href="#x">H</a>
        <fieldset disabled><input id="i"></fieldset>
        <input type="radio" name="r" id="r1"><input type="radio" name="r" id="r2" checked><input type="radio" name="r" id="r3">
        <input type="radio" name="s" id="s1"><input type="radio" name="s" id="s2">
        <div tabindex="0" id="j">J</div>
      </div>`;
    expect(tabbables($('root')).map((el) => el.id)).toEqual(['a', 'h', 'r2', 's1', 'j']);
  });
});

describe('trapFocus: a modal dialog keeps Tab inside (access, Section 10.6)', () => {
  function dialog() {
    document.body.innerHTML = `
      <button id="behind">Behind</button>
      <div id="dlg"><h2 id="title" tabindex="-1">Workshop</h2><button id="first">Close</button><button id="mid">Middle</button><button id="last">Last</button></div>
      <button id="after">After</button>`;
    return trapFocus($('dlg'));
  }

  it('goes round from the last stop to the first, and back', () => {
    dialog();
    $('last').focus();
    expect(tab($('last')).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($('first'));
    expect(tab($('first'), true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($('last'));
  });

  it('leaves the browser to move between stops inside', () => {
    dialog();
    $('mid').focus();
    expect(tab($('mid')).defaultPrevented).toBe(false);
    expect(tab($('mid'), true).defaultPrevented).toBe(false);
  });

  it('wraps from the title the dialog focuses on opening, which is no stop itself', () => {
    dialog();
    $('title').focus();
    expect(tab($('title'), true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($('last'));
    $('title').focus();
    expect(tab($('title')).defaultPrevented).toBe(false);
  });

  it('lets go when the dialog goes', () => {
    dialog().destroy();
    $('last').focus();
    expect(tab($('last')).defaultPrevented).toBe(false);
  });
});

describe('restoreFocus (focus is never left on nothing)', () => {
  it('gives focus back to the element that had it, once focus has fallen to the page', () => {
    document.body.innerHTML = '<button id="opener">Open spellbook</button><div id="dlg"><button id="inside">Close book</button></div>';
    $('inside').focus();
    $('dlg').remove();
    expect(document.activeElement).toBe(document.body);
    restoreFocus($('opener'));
    expect(document.activeElement).toBe($('opener'));
  });

  // The Workshop opened from a page of the book has focused its own title before the book has gone.
  it('leaves focus that another screen has placed meanwhile', () => {
    document.body.innerHTML = '<button id="opener">Open spellbook</button><h2 id="workshop" tabindex="-1">Workshop</h2>';
    $('workshop').focus();
    restoreFocus($('opener'));
    expect(document.activeElement).toBe($('workshop'));
  });

  it('falls back to the Mirror bar’s first button when the opener is gone', async () => {
    document.body.innerHTML = '<button id="gone">Back to book</button>';
    const gone = $('gone');
    gone.remove();
    restoreFocus(gone);
    // The Mirror bar comes in the same update as the closing screen goes.
    document.body.insertAdjacentHTML('beforeend', `<button id="home" ${FOCUS_HOME.slice(1, -1)}>Open spellbook</button>`);
    expect(document.activeElement).toBe(document.body);
    await Promise.resolve();
    expect(document.activeElement).toBe($('home'));
  });

  it('falls back as well when the page itself had focus before', async () => {
    document.body.innerHTML = `<button id="home" ${FOCUS_HOME.slice(1, -1)}>Open spellbook</button>`;
    restoreFocus(document.body);
    await Promise.resolve();
    expect(document.activeElement).toBe($('home'));
  });
});

describe('focusIfLost', () => {
  it('focuses only when focus has fallen to the page', () => {
    document.body.innerHTML = '<button id="a">Delete</button><button id="b">Keep it</button>';
    $('b').focus();
    focusIfLost($('a'));
    expect(document.activeElement).toBe($('b'));
    $('b').remove();
    focusIfLost($('a'));
    expect(document.activeElement).toBe($('a'));
  });

  it('ignores an element that is gone', () => {
    document.body.innerHTML = '<button id="a">Delete</button>';
    const a = $('a');
    a.remove();
    focusIfLost(a);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('focusOnMount', () => {
  it('moves focus to the title on opening, and back to the opener when it closes', async () => {
    document.body.innerHTML = '<button id="opener">Workshop</button><div id="dlg"><h2 id="title">Workshop</h2><button>Close</button></div>';
    $('opener').focus();
    const action = focusOnMount($('dlg'));
    await Promise.resolve();
    expect(document.activeElement).toBe($('title'));
    $('dlg').remove();
    action.destroy();
    expect(document.activeElement).toBe($('opener'));
  });

  it('does not pull focus back from a screen opened meanwhile', async () => {
    document.body.innerHTML = '<button id="opener">Open spellbook</button><div id="dlg"><h2>Spellbook</h2></div><h2 id="next" tabindex="-1">Workshop</h2>';
    $('opener').focus();
    const action = focusOnMount($('dlg'));
    await Promise.resolve();
    $('next').focus();
    $('dlg').remove();
    action.destroy();
    expect(document.activeElement).toBe($('next'));
  });
});
