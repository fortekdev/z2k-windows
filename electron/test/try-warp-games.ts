import { listGames, updateGames, gameEntries } from '../src/warp/lists';
(async () => {
  console.log(await updateGames());
  const g = listGames();
  console.log(g.length, 'games;', g.slice(0, 6).map((x) => `${x.id}(${x.ips} ip, ${x.domains} dom)`).join(', '));
  const v = gameEntries(g[0].id);
  console.log(g[0].id, v.ips.slice(0, 3), v.domains.slice(0, 3), 'invalid', v.invalid.length);
})();
