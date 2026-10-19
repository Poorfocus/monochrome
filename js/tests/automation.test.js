import { describe, expect, test, vi } from 'vitest';

vi.mock('../music-api.js', () => ({ MusicAPI: { instance: null } }));
vi.mock('../lyrics.js', () => ({ LyricsManager: { instance: null } }));

const { parseAlbumRequest, pickBestMatch, scoreAlbum } = await import('../automation.js');

const album = (id, title, artist, extra = {}) => ({ id, title, artist: { name: artist }, ...extra });

describe('parseAlbumRequest', () => {
    test.each([
        ['Radiohead - OK Computer', { artist: 'Radiohead', title: 'OK Computer' }],
        ['Daft Punk – Discovery', { artist: 'Daft Punk', title: 'Discovery' }],
        ['Kendrick Lamar: good kid, m.A.A.d city', { artist: 'Kendrick Lamar', title: 'good kid, m.A.A.d city' }],
        ['1. Abbey Road by The Beatles', { artist: 'The Beatles', title: 'Abbey Road' }],
        ['- Jay-Z - The Blueprint', { artist: 'Jay-Z', title: 'The Blueprint' }],
        ['Blonde', { artist: '', title: 'Blonde' }],
    ])('%s', (input, expected) => {
        expect(parseAlbumRequest(input)).toEqual(expected);
    });
});

describe('matching', () => {
    test('accents, case and "The" do not matter', () => {
        expect(scoreAlbum({ artist: 'beyonce', title: 'lemonade' }, album(1, 'LEMONADE', 'Beyoncé'))).toBe(1);
        expect(scoreAlbum({ artist: 'Beatles', title: 'Abbey Road' }, album(2, 'Abbey Road', 'The Beatles'))).toBe(1);
    });

    test('a different artist with the same title is not a confident match', () => {
        const { match } = pickBestMatch({ artist: 'Radiohead', title: 'Not An Album' }, [
            album(1, 'Not an Album', 'Floats'),
        ]);
        expect(match).toBeNull();
    });

    test('editions of the same album pick the standard one', () => {
        const { match } = pickBestMatch({ artist: 'The Beatles', title: 'Abbey Road' }, [
            album(1, 'Abbey Road (Super Deluxe Edition)', 'The Beatles', { releaseDate: '2019-09-27' }),
            album(2, 'Abbey Road (Remastered)', 'The Beatles', { releaseDate: '1969-09-26' }),
        ]);
        expect(match.album.id).toBe(2);
    });

    test('asking for the deluxe edition gets it', () => {
        const { match } = pickBestMatch({ artist: 'The Beatles', title: 'Abbey Road Super Deluxe Edition' }, [
            album(1, 'Abbey Road (Super Deluxe Edition)', 'The Beatles'),
            album(2, 'Abbey Road (Remastered)', 'The Beatles'),
        ]);
        expect(match.album.id).toBe(1);
    });

    test('two different albums that score the same are ambiguous', () => {
        const result = pickBestMatch({ artist: '', title: 'Greatest Hits' }, [
            album(1, 'Greatest Hits', 'Queen'),
            album(2, 'Greatest Hits', 'Guns N’ Roses'),
        ]);
        expect(result.match).toBeNull();
        expect(result.ambiguous).toBe(true);
    });
});
