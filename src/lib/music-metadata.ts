// One descriptive identity for the full mix AND all of its stems. Never use
// these labels as audio/cue/cache keys: those retain the original Drive ID/name.
export type GenreSource = "song" | "artist-estimate" | "tag" | "owner" | "unknown";
export interface MusicMetadata {
  artist: string;
  title: string;
  genre: string;
  genreSource: GenreSource;
}
export interface MetadataTrack {
  id?: string | null; name: string; artist?: string | null; title?: string | null;
  genre?: string | null; genreSource?: GenreSource;
}
export function musicKey(value: string): string {
  return value.normalize("NFKD").replace(new RegExp("\\p{M}", "gu"), "").toLowerCase()
    .replace(new RegExp("[^\\p{L}\\p{N}]+", "gu"), " ").trim();
}
export function meaningfulGenre(value?: string | null): string {
  return /^(music|other|unknown|undefined|\(?\d+\)?)?$/i.test(value?.trim() ?? "") ? "" : value!.trim();
}

// Uploader/title-order exceptions, identified by immutable video IDs or exact
// original filenames. Version qualifiers are intentional; never erase a remix,
// instrumental, live recording or salsa/bachata version to make a label shorter.
const NAMES: Record<string, [string, string]> = {
  X4Mqm0sBGYE: ["Bad Bunny", "A Tu Merced"], mGmwKDHr2C4: ["Bad Bunny", "25/8"],
  MG2S0ns8Dj8: ["JAY-Z & Linkin Park", "Dirt Off Your Shoulder / Lying From You"],
  spbagny8OjM: ["Kapo", "UWAIE"], lmDfmilZ4Xo: ["Kapo", "OHNANA"],
  dMOWydjN4Yo: ["C. Rosas", "Canción del Mariachi (Orquesta de Guitarras)"],
  "9XvXF1LrWgA": ["Eminem feat. Juice WRLD", "Godzilla"],
  "6WfkgpsI_vc": ["Ozuna feat. Pedro Capó", "Mar Chiquita"],
  IWrZpP24H8I: ["Manuel Turizo, Rauw Alejandro & Myke Towers", "La Nota"],
  jPuI81bHwI8: ["KYEN?ES?", "El Carnaval de Celia (Tribute Medley)"],
  R8egmh5dWzo: ["Calvin Harris", "Feel So Close (Radio Edit)"],
  QrcBFU2gLzY: ["Enrique Iglesias feat. Yandel & Juan Magán", "Noche y de Día"],
  Iriq2tqhNBk: ["Rick Ross feat. T-Pain", "The Boss"],
  K2t5a_IwGMo: ["Kevvo, Farruko, Myke Towers, Arcángel, Darell, Ñengo Flow & Brytiago", "105 (Remix, Bass Boosted)"],
  "4pocLm7xhhc": ["Calvin Harris feat. John Newman", "Blame"],
  OMZhaXkFnpw: ["Bad Bunny", "Super Bowl LX Halftime Show (Live Medley)"],
  p1AaWyyPrCQ: ["Chris Brown, Drake, Kanye West & André 3000", "Deuces (Remix, Dirty Version)"],
  "7pV7m0XWXAw": ["Geto Boys feat. Mr. 3-2", "Straight Gangstaism"],
  xu1YFllRSK8: ["Daddy Yankee", "Bailando en la Lluvia"],
  cGeI10EyPAc: ["Raekwon feat. Ghostface Killah & Nas", "Verbal Intercourse"],
  Q92V3wfOF38: ["Don Omar / Kaoma", "Taboo / Lambada (Video Edit)"],
  vFCDey96qEI: ["Oscar D'León", "Llorarás (Live in Miami)"],
  W3Cky5s5E94: ["Sean Paul feat. Dua Lipa", "No Lie"],
  HjceWfLiJJY: ["Pitbull", "Muévelo Loca Boom Boom"],
  oC5xgoTatUA: ["Gente de Zona", "Por Ti (PMM)"],
  oWaCQrDGtUg: ["Marc Anthony", "Celos"],
  "3k8nCv6xw8A": ["Marc Anthony, Will Smith & Bad Bunny", "Está Rico"],
  g4A1kCIP2R0: ["J Balvin", "Azul"],
  jsur8561_1A: ["Eminem", "Fall"],
  zODmu06pqvg: ["Don Omar", "Dile"],
  q5mM2jUIsW8: ["Bad Bunny", "Una Velita"],
  "-JwL3lPBQ5E": ["Bob Marley & The Wailers", "War (1976)"],
  fRid8Tjw_bU: ["Bob Marley & The Wailers", "Turn Your Lights Down Low (1977)"],
  UZfaIx57UqU: ["Bob Marley & The Wailers", "Natural Mystic (1977)"],
  VjbyOqsIKNE: ["Do or Die", "Scarface / Po Pimpin (Interview — not a song)"],
  PhLuyBT9zpg: ["Romeo Santos", "Su Veneno (Live - The King Stays King Version)"],
  "bx-fuY7LpSU": ["Ozuna & Manuel Turizo", "Vaina Loca"],
  BYJ1ZocKjIA: ["Mambo Kingz feat. Ozuna, Luigi 21 Plus, Kevin Roldan, Pusho & Alexio", "Me Reclama (Remix)"],
  "Aguanile.mp3": ["Willie Colón & Héctor Lavoe", "Aguanile"],
  "Azul.mp3": ["J Balvin", "Azul"], "Bora Bora.mp3": ["Gente de Zona", "Bora Bora"],
  "Pepas.mp3": ["Farruko", "Pepas"],
  "Pa' Los Envidiosos.mp3": ["Blessd", "Pa' Los Envidiosos"],
  "El Día De Mi Suerte.mp3": ["Willie Colón & Héctor Lavoe", "El Día de Mi Suerte"],
  "Salsa Clasica - Un Verano En NY - Salsa Clasica.mp3": ["El Gran Combo de Puerto Rico", "Un Verano en Nueva York"],
  "09SourApple - La Vida Es Un Carnaval - Celia Cruz.mp3": ["Celia Cruz", "La Vida Es un Carnaval"],
  "Bizarrap - QUEVEDO || BZRP Music Sessions #52⧸66.mp3": ["Bizarrap & Quevedo", "BZRP Music Sessions #52/66"],
  "Bizarrap, Daddy Yankee, Gonzalo Julián Conde, Santiago Alvarado - Daddy Yankee: Bzrp Music Sessions, Vol. 0⧸66.mp3": ["Bizarrap & Daddy Yankee", "BZRP Music Sessions, Vol. 0/66"],
  "Bizarrap, Villano Antillano, Gonzalo Julián Conde, Villana Santiago Pacheco - Villano Antillano: Bzrp Music Sessions, Vol. 51⧸66.mp3": ["Bizarrap & Villano Antillano", "BZRP Music Sessions, Vol. 51/66"],
  "Don Omar - Don Omar Ft  Plan B | Hooka 🔥.mp3": ["Don Omar feat. Plan B", "Hooka"],
  "Gente De Zona, Nacho - [CONTIGO].mp3": ["Gente de Zona & Nacho", "Contigo"],
  "Manuel Turizo - La Bachata - MTZ Manuel Turizo | Video Oficial.mp3": ["Manuel Turizo", "La Bachata"],
  "NickyJamTV - 22. Hasta el Amanecer - Nicky Jam | Video Oficial.mp3": ["Nicky Jam", "Hasta el Amanecer"],
  "NickyJamTV - X Remix - Nicky Jam x J Balvin x Ozuna x Maluma.mp3": ["Nicky Jam, J Balvin, Ozuna & Maluma", "X (Remix)"],
  "NickyJamTV - X (EQUIS) - Nicky Jam x J. Balvin | Video Oficial  (Prod. Afro Bros & Jeon).mp3": ["Nicky Jam & J Balvin", "X (EQUIS)"],
  "Hear This Music - Loco Remix - Beéle x Farruko x Natti Natasha x Manuel Turizo.mp3": ["Beéle, Farruko, Natti Natasha & Manuel Turizo", "Loco (Remix)"],
  "Geto Boys - Still - 20s Instrumental Loop.mp3": ["Geto Boys", "Still (20s Instrumental Loop)"],
  "Justin Quiles - Justin Quiles @NattiNatasha @farruko Zion @dalex @LennyTavarezMusic DJ No Pare REMIX (Video Oficial).mp3": ["Justin Quiles, Natti Natasha, Farruko, Zion, Dalex & Lenny Tavárez", "DJ No Pare (Remix)"],
  "Justin Quiles - Justin Quiles, @ChimbalaHD  @ZionLennox   - Loco (Video Oficial).mp3": ["Justin Quiles, Chimbala & Zion & Lennox", "Loco"],
  "Pitbull - Pitbull, @farruko ,  @iamchino , @ElAlfaElJefeTV  x @OmarCourtz - Ten (Music Video).mp3": ["Pitbull, Farruko, IAmChino, El Alfa & Omar Courtz", "Ten"],
  "Farruko - Farruko \"Mi Forma de Ser\" (Official Video).mp3": ["Farruko", "Mi Forma de Ser"],
  "Farruko - Farruko -  S ̶A̶N̶  MIG ̶U̶E̶L̶.mp3": ["Farruko", "San Miguel"],
  "Arcangel, Bad Bunny - Infeliz feat. Bunny Bunny.mp3": ["Arcángel & Bad Bunny", "Infeliz"],
  "Bad Bunny - Si Estuviésemos Juntos Juntos.mp3": ["Bad Bunny", "Si Estuviésemos Juntos"],
  "Reggaeton Latino - Bailando - Reggaeton Latino.mp3": ["Reggaeton Latino", "Bailando"],
  // Artists below verified from the actual Drive MP3 TPE1 frames, not guesses.
  "01 - Perfect Duet (with Beyoncé).mp3": ["Ed Sheeran", "Perfect Duet (with Beyoncé)"],
  "02 - Just the Way You Are.mp3": ["Bruno Mars", "Just the Way You Are"],
  "01 - Ocean.mp3": ["Karol G", "Ocean"],
  "01 - Is This Love.mp3": ["Bob Marley", "Is This Love"],
  "songvideostube - no le pegue a la negra joe arroyo.mp3": ["Joe Arroyo", "Rebelión (No le Pegue a la Negra)"],
  "el_cerebro_dembow_fuego.mp3": ["DJ Supermercado feat. El Cerebro", "El Cerebro — Dembow Fuego (VIP Club Mix)"],
  "supermercado_salsa_brava.mp3": ["Orquesta Supermercado", "Supermercado Salsa Brava (Descarga en Vivo)"],
  "medianoche_tech_guaracha.mp3": ["DJ Supermercado", "Medianoche Tech Guaracha (Aleteo Club Tool)"],
  "costa_dorada_bachata_vip.mp3": ["DJ Supermercado", "Costa Dorada — Bachata Sensual (VIP Dub)"],
};
const BUNNY_TITLES = new Set(["BAILE INoLVIDABLE", "CAFé CON RON", "DtMF", "EoO", "LO QUE LE PASÓ A HAWAii", "LA MuDANZA", "Me Porto Bonito", "NUEVAYoL", "PIToRRO DE COCO", "WELTiTA", "VOY A LLeVARTE PA PR", "Tití Me Preguntó", "El Apagón", "Después de la Playa"].map(musicKey));
const WRITER_CREDITS = /^(?:Benito|Austin Santos|Roberto Jos[eé]|Marco Daniel|Luis Amed|Marcos Efra[ií]n|Flor Morales|Jay Anthony|Ricardo Garc[ií]a|Francis Rivera|Miguel A|Juan Ivan|Llandel Veguilla|Tegui Calder[oó]n|Joel Mu[nñ]oz|Randy Ortiz|Edwin Rosa|Raymond Ayala|Gonzalo Juli[aá]n|Villana Santiago|Santiago Alvarado|Ni Garcia)\b/i;

export function cleanMusicName(raw: string): { artist: string; title: string } {
  const video = /\[([\w-]{11})\](?:\.mp3)?$/i.exec(raw)?.[1];
  const fixed = NAMES[raw] ?? (video ? NAMES[video] : undefined);
  if (fixed) return { artist: fixed[0], title: fixed[1] };
  let value = raw.normalize("NFKC").replace(/⧸/g, "/").replace(/\.mp3$/i, "")
    .replace(/\[[\w-]{11}\]/g, "")
    .replace(/[([][^)\]]*(?:official|oficial|visualizer|letra|lyrics?|HD UPGRADE|HD Remaster|video vertical|cvrbon vrmor)[^)\]]*[)\]]/gi,
      group => /remix/i.test(group) ? "(Remix)" : /versi[oó]n urbana/i.test(group) ? "(Versión Urbana)" : " ")
    .replace(/[([]\s*(?:audio|HQ|HD|explicit(?:\s+version|\s+lyrics)?|genesis|remaster)\s*[)\]]/gi, " ")
    .replace(/\[HD\[/gi, " ").replace(/\s*\|.*$/, "")
    .replace(/\b(?:Official Music HQ Sound|Official Video|Video Oficial)\b/gi, "")
    .replace(new RegExp("[🍯🐝🔥🎵]", "gu"), "").replace(/\s+/g, " ").trim();
  // Split only outside parentheses, so `(Remix - Live)` stays part of TITLE.
  let depth = 0;
  value = Array.from(value).map((ch) => {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    return depth && /[-–—]/.test(ch) ? "\u0001" : ch;
  }).join("");
  const segments = value.split(/\s+[-–—]\s+/).map(s => s.replace(/\u0001/g, "-").trim()).filter(Boolean);
  let artist = segments.length > 1 ? segments.at(-2)! : "";
  let title = segments.at(-1) ?? value;
  if (/^\d+$/.test(artist)) artist = ""; // track number is not an artist
  if (!artist && BUNNY_TITLES.has(musicKey(title))) artist = "Bad Bunny";
  artist = artist.replace(/^0\d+\s+/, "").replace(/JAŸ-Z/g, "JAY-Z").replace(/\bJ\.\s?Balvin/gi, "J Balvin")
    .split(/,\s*/).filter(s => !WRITER_CREDITS.test(s) && !musicKey(s).startsWith("roberto jose")).join(", ")
    .replace(/(?:\s+[x❌]\s+|\s+Ft\.?\s+)/gi, " & ").replace(/@/g, "").replace(/,\s*$/, "").trim();
  if (artist === "DY") artist = "Daddy Yankee";
  title = title.replace(/\[remix\]/gi, "(Remix)").replace(/\s*\+\s*bonus track$/i, "")
    .replace(/\s+(?:HQ|HD|[.\-]+)$/, "").replace(/\(Audio HD\)|\(Music Video\)/gi, "").replace(/Remix\/Audio/gi, "Remix").trim();
  return { artist, title };
}

// Song exceptions take precedence over artist profiles. These are DJ library
// classifications, NOT claims to have listened to or verified every recording.
// Every profile-based fallback is explicitly marked for review in UI and brain.
const SONG_GENRES: [RegExp, RegExp, string][] = [
  [/bad bunny/i, /^(baile inolvidable|la mudanza)$/, "Salsa"],
  [/bad bunny/i, /^(despues de la playa)$/, "Merengue"],
  [/bad bunny/i, /^(cafe con ron|dtmf|una velita)$/, "Plena"],
  [/bad bunny/i, /^(lo que le paso a hawaii|pitorro de coco)$/, "Jíbaro"],
  [/bad bunny/i, /^nuevayol$/, "Dembow"],
  [/bad bunny/i, /^(amorfoda|si estuviesemos juntos)/, "Latin Pop"],
  [/bad bunny/i, /^(soy peor|chambea|monaco|25 8|ni bien ni mal|tu no metes cabra|otra noche en miami|rlndt|diles|me mata|p fkn r|solo de mi)/, "Latin Trap"],
  [/bad bunny/i, /^where she goes$/, "Jersey Club"],
  [/bad bunny/i, /^ojitos lindos$/, "Reggae Pop"],
  [/bad bunny/i, /^(el apagon|ensename a bailar)$/, "House"],
  [/romeo santos/i, /^bella y sensual$/, "Reggaeton"],
  [/aventura.*bad bunny/i, /^volvi$/, "Bachata / Reggaeton"],
  [/prince royce/i, /^el clavo/, "Reggaeton"],
  [/marc anthony/i, /^esta rico$/, "Reggaeton"],
  [/enrique iglesias/i, /^el perdedor bachata/, "Bachata"],
  [/shakira.*ozuna/i, /^monotonia$/, "Bachata"],
  [/manuel turizo|lenier/i, /^la bachata$/, "Bachata"],
  [/karol g/i, /^si antes te hubiera conocido$/, "Merengue"],
  [/farruko/i, /^(pepas|el incomprendido|nazareno|turbina)/, "Guaracha"],
  [/farruko/i, /^(krippy kush|la cartera|delincuente)/, "Latin Trap"],
  [/farruko/i, /^(chillax|passion whine|sunset)/, "Dancehall"],
  [/j balvin/i, /^in da getto$/, "House"],
  [/j balvin/i, /^un dia/, "Dance Pop"],
  [/rauw alejandro/i, /^todo de ti$/, "Dance Pop"],
  [/rosalia/i, /^despecha$/, "Merengue"],
  [/don omar/i, /^danza kuduro\b/, "Kuduro"],
  [/don omar/i, /^taboo/, "Latin Dance"],
  [/raymix/i, /^oye mujer$/, "Cumbia"],
  [/maluma/i, /^que chimba$/, "Guaracha"],
  [/maluma/i, /^(marinero|admv)(?!.*urbana)/, "Latin Pop"],
  [/maluma/i, /^(cuatro babys|gps|un polvo)/, "Latin Trap"],
  [/dj snake/i, /^taki taki/, "Reggaeton"],
  [/travis scott.*hvme/, /^goosebumps/, "House"],
  [/cardi b/, /dillon francis remix/, "Dance"],
  [/bizarrap.*(quevedo|daddy yankee)/, /bzrp/, "Reggaeton"],
  [/bizarrap.*villano antillano/, /bzrp/, "Hip-Hop"],
  [/blessd/, /^pa los envidiosos$/, "Reggaeton"],
  [/residente.*bad bunny/, /^bellacoso$/, "Reggaeton"],
  [/calle 13/, /^atrevete te te$/, "Reggaeton"],
  [/antonio banderas|c rosas/, /cancion del mariachi/, "Mariachi"],
  [/gloria estefan/, /^conga$/, "Latin Dance"],
  [/luis fonsi/, /^despacito/, "Reggaeton"],
  [/enrique iglesias/, /^(el bano|me pase|duele el corazon|pendejo|te fuiste|como yo)/, "Reggaeton"],
  [/enrique iglesias/, /^(tonight|i like it)/, "Dance Pop"],
  [/enrique iglesias/, /^(noche y de dia|tamo bien)/, "Latin Dance"],
  [/ricky martin/, /^pegate$/, "Plena"],
  [/shakira/, /^loca$/, "Merengue"],
  [/shakira/, /^clandestino$/, "Reggaeton"],
  [/marc anthony/, /^punta cana$/, "Bachata"],
  [/bad bunny/, /^(hablamos manana|estamos bien|caro|dime si te acuerdas|no me quiero casar|pa ti)/, "Latin Trap"],
  [/arcangel/, /^(tu no vive asi|me acostumbre|la jumpa|infeliz|payaso)/, "Latin Trap"],
  [/chris jedi|revol|mark b|jory boy/, /^(ahora dice|me ama me odia|me llueven|no te hagas)$/, "Latin Trap"],
  [/ozuna/, /^(el farsante|solita\b)/, "Latin Trap"],
  [/bad bunny/, /^la romana/, "Dembow / Latin Trap"],
  [/bad bunny/, /^si veo a tu mama$/, "Latin Pop"],
  [/bad bunny/, /^weltita$/, "Latin Pop"],
  [/karol g/, /^ahora me llama$/, "Latin Trap"],
  [/reggaeton latino/, /^bailando$/, "Reggaeton"],
  [/karol g/, /^ocean$/, "Latin Pop"],
  [/dj supermercado/, /dembow fuego/, "Reggaeton / Dembow"],
  [/orquesta supermercado/, /salsa brava/, "Salsa / Tropical"],
  [/dj supermercado/, /medianoche tech guaracha/, "Latin Tech House / Guaracha"],
  [/dj supermercado/, /costa dorada.*bachata/, "Bachata"],
  // Verified song-level genres for the remaining crate recordings (keeps unknown future tracks on artist-estimate).
  [/^(marc anthony|celia cruz|willie colon|hector lavoe|oscar d leon|oscar de leon|dimension latina|el gran combo|la misma gente|joe arroyo|kyen)/, /^(1 2 3 azucar|aguanile|ale ale|celos|el carnaval de celia|el dia de mi suerte|el que te amaba|ella mintio|flor palida|la murga|la negra tiene tumbao|la vida es un carnaval|lloraras|oye como va|oye mi canto|pa lla voy|parecen viernes|quimbara|rebelion|tu y yo|un verano en nueva york|vivir mi vida)\b/, "Salsa"],
  [/^(aventura|romeo santos|prince royce|xtreme|bachata heightz)/, /^(7 dias|all out of love|boomerang|corazon sin cara|dancing in the moonlight|darte un beso|dile al amor|eres mia|how deep is your love|i just called to say i love you|i want it that way|if only for one night|imitadora|incondicional|inmortal|inocente|killing me softly|la diabla|llevame contigo|los infieles|mar|me puedo matar|necio|obsesion|odio|promise|propuesta indecente|right here waiting|sobredosis|solo conmigo|stand by me|stuck on you|su veneno|sus huellas|te extrano|un beso)\b/, "Bachata"],
  [/^elvis crespo/, /^(suavemente|tu sonrisa)$/, "Merengue"],
  [/^(gente de zona|jacob forever|el micha)/, /^(after party|algo contigo|ay martica|bora bora|celia|contigo|demasiado|ella|feliz|habanero|hablame de miami|hazle completo el cuento|isla viva|la fiesta no se ha acabado|la gozadera|lo menea como e|loco loco|momento|pa los haters|por ti|quiereme|quiero conocerte|se le pasa|seductora|sere|si no vuelves|sol y arena|sone|tan buena|te duele|tiktok)\b/, "Cubaton"],
  [/^(dr dre|outkast|nas|n w a|nwa|eminem|cypress hill|common|lil wayne|geto boys|the notorious|jay z|nicki minaj|meek mill|kool g rap|eazy e|busta rhymes|drake|wu tang|raekwon|az |souls of mischief|naughty by nature|method man|makaveli|jadakiss|fat joe|a tribe called quest|50 cent|rick ross|fabolous)/, /^(03 bonnie clyde|1nce again|3 peat|6 foot 7 foot|a milli|all the way up|atliens|b o b|banned from no|blunt blowin|breathe|dirt off your shoulder|drop the world|empire state of mind|ether|fall|fast life|feel me|first light of the day|get down|geto boys and girls|godzilla|got money|hand on the pump|hold it down|hollow bones|how i could just kill a man|i get money|i just wanna love u|i like the view|i used to love h e r|it ain t|jazzy belle|kobe bryant|make your mind up|many men|me and my girlfriend|megaman|moment 4 life|money ain t a thang|no love|part ii|player s ball|real muthaphuckkin g s|reunited|right above it|rosa parks|run this town|scarface|seeing green|song cry|still|straight gangstaism|straight outta compton|stranded on death row|sugar hill|sure thing|take it in blood|takeover|the boss|the ringer|the world is a ghetto|things done changed|time taker|twist made me|u don t know|up all night|verbal intercourse|what it is|what s free|ya ll been warned)\b/, "Hip-Hop"],
  [/^(red hot chili peppers|lynyrd skynyrd|led zeppelin|the rolling stones|linkin park)/, /^(can t you hear me knocking|good times bad times|scar tissue|soul to squeeze|stairway to heaven|the ocean|tuesday s gone|when the levee breaks)\b/, "Rock"],
  [/^(mana|juanes)/, /^(la camisa negra|oye mi amor|te llevare al cielo)$/, "Latin Rock"],
  [/^(bob marley|tribal seeds)/, /^(could you be loved|in your eyes|is this love|natural mystic|sun is shining|turn your lights down low|war)\b/, "Reggae"],
  [/^sean paul/, /^(gimme the light|no lie|she doesn t mind|we be burnin)\b/, "Dancehall"],
  [/^(kapo|rema)/, /^(calm down|ohnana|uwaie)$/, "Afrobeats"],
  [/^(darude|ppk|voodoo|paul van dyk|paul oakenfold|yahel|ferry corsten)/, /^(blood is pumpin|feel the beat|reload|sandstorm)\b/, "Trance"],
  [/^anyma/, /^atmosphere$/, "Melodic Techno"],
  [/^(tiesto|calvin harris|david guetta|edward maya|hvme|daft punk)/, /^(blame|don t be shy|feel so close|get lucky|goosebumps|i m good|stereo love|the business|yesterday)\b/, "House"],
  [/^(dayvi|deorro)/, /^(baila conmigo|bailar)\b/, "Guaracha"],
  [/^carlos vives/, /^la gota fria\b/, "Vallenato"],
  [/^(ed sheeran|bruno mars)/, /^(just the way you are|perfect duet)\b/, "Pop"],
  [/^victor valverde/, /^el mayor de los ranas$/, "Corridos"],
  [/^chris brown/, /^deuces\b/, "R&B"],
  [/^(khea|trap capos|pepe quintana)/, /^(de las 2|ella y yo|loca)\b/, "Latin Trap"],
  [/^(play n skillz|descemer bueno)/, /^(despues que bailamos|somos latinos)$/, "Latin Dance"],
  [/^(sikdope|marshmello|juan magan)/, /^(esta vida|munequita linda|sandstorm)\b/, "Dance"],
  [/^(pitbull|black eyed peas|jennifer lopez)/, /^(bailar contigo|cantare|don t stop the party|feel this moment|give me everything|hoy se bebe|muevelo loca boom boom|on the floor|rain over me|ritmo|ten|ten cuidado|timber|time of our lives)\b/, "Dance Pop"],
  [/^(enrique iglesias|shakira|luis fonsi|kany garcia|ricky martin|reik|thalia|sebastian yatra|tini|pedro capo)/, /^(bailando|calma|dai dai|desde esa noche|echame la culpa|la culpa|me niego|mienteme|soltera|traicionera|vente pa ca)\b/, "Latin Pop"],
  [/^(rosalia|manuel turizo|kevvo|mambo kingz|abraham mateo|milly|beele|klasico|revol|yng lvcas|dj snake|wizzars|louis bpm|mark b|hear this music|chyno miranda|bad bunny|j balvin|daddy yankee|don omar|farruko|ozuna|maluma|karol g|wisin|yandel|zion|nicky jam|nio garcia|jhayco|jhay cortez|rauw alejandro|sech|becky g|natti natasha|lunay|justin quiles|jory boy|brytiago|rvssian|myke towers|arcangel|alexis|alexio|anuel aa|baby rasta|alex sensation|chris jedi|n o r e|nacho|piso 21|chino|de la ghetto|tito el bambino|tito "el bambino")/, /^(105|11 pm|23|50 sombras de austin|6 am|911|a tu merced|abatido|adictiva|admv|algo me gusta de ti|am|amarillo|amor prohibido|andas en mi cabeza|ay dale|ay vamos|ayo ayo|azul|baby|baccarat|baila baila baila|bailame|bailando en la lluvia|bajo y bateria|beso|bichota|bobo|bonita|borro cassette|bronceador|cairo|callaita|cancion con yandel|carnaval|china|como antes|como se siente|como un bebe|con calma|corazon|cositas que haciamos|criminal|dakiti|dale don dale|dalmation|desesperados|devuelveme|dile|dj no pare|don t let go|dura|efecto|el makinon|el perdedor|el tiki|encantadora|eoo|escapate conmigo|explicale|fantasias|felices los 4|formal|gasolina|ginza|hangover|hasta abajo|hasta el amanecer|hawai|hooka|hp|ibiza|ignorantes|la bebe|la bendicion|la cancion|la corriente|la formula|la noche de anoche|la nota|la rompe corazones|la santa|la temperatura|la toxica|la zona|limbo|llegamos a la disco|loco|lovumba|machika|madrid|mala|mar chiquita|mayores|me gustas|me llamas|me porto bonito|me reclama|me voy enamorando|mi forma de ser|mi gente|mia|nadie|nervios de acero|netflixxx|no me conoce|no mienten|no quiere enamorarse|no te enamores|noche de sexo|nota de amor|obsesion|obsesionado|otra noche sin ti|otra vez|otro trago|oye mi canto|pa romperla|pasarla bien|perfumito nuevo|pierdo la cabeza|plakito|poblado|pobre diabla|ponle|prendia|privado|provenza|pura vida|que mas pues|que pena|que pretendes|que tire pa lante|que va|quedate conmigo|quiero mas|quiero repetir|ram pam pam|real guerrero|relacion|rompe|safaera|safari|salgo pa la calle|san miguel|se preparo|sensualidad|shofar|si se da|si tu novio te deja sola|sigo extranandote|siguelo bailando|sin contrato|soltera|sonriele|te bote|temporal|tiempos buenos|titi me pregunto|tqg|tranquilo|tu carino|tu foto|tu olor|tumba la casa|tusa|un get|un peso|una aventura|una en un millon|una noche en medellin|una nota|una vez|una vida|unica|vacaciones|vaina loca|vaiven|velda|vete|viaje|visionary|volver|voy a llevarte pa pr|vuelve|x|ya no es nina|yapaque|yo le llego|yo perreo sola|yo x ti tu x mi|yonaguni)\b/, "Reggaeton"],
];
const ARTIST_GENRES: [RegExp, string][] = [
  [/^(marc anthony|celia cruz|willie colon|hector lavoe|oscar d leon|oscar de leon|dimension latina|el gran combo|la misma gente|joe arroyo|kyen)/, "Salsa"],
  [/^(aventura|romeo santos|prince royce|xtreme|bachata heightz)/, "Bachata"],
  [/^elvis crespo/, "Merengue"],
  [/^(gente de zona|jacob forever|el micha)/, "Cubaton"],
  [/^(dr dre|outkast|nas|n w a|nwa|eminem|cypress hill|common|lil wayne|geto boys|the notorious|jay z|nicki minaj|meek mill|kool g rap|eazy e|busta rhymes|drake|wu tang|raekwon|az |souls of mischief|residente|naughty by nature|method man|makaveli|jadakiss|fat joe|a tribe called quest|50 cent|rick ross|fabolous|calle 13)/, "Hip-Hop"],
  [/^(red hot chili peppers|lynyrd skynyrd|led zeppelin|the rolling stones|linkin park)/, "Rock"],
  [/^(mana|juanes)/, "Latin Rock"],
  [/^(bob marley|tribal seeds)/, "Reggae"],
  [/^sean paul/, "Dancehall"],
  [/^(kapo|rema)/, "Afrobeats"],
  [/^(darude|ppk|voodoo|paul van dyk|paul oakenfold|yahel|ferry corsten)/, "Trance"],
  [/^anyma/, "Melodic Techno"],
  [/^(tiesto|calvin harris|david guetta|edward maya|hvme|daft punk)/, "House"],
  [/^(dayvi|deorro)/, "Guaracha"],
  [/^carlos vives/, "Vallenato"],
  [/^(ed sheeran|bruno mars)/, "Pop"],
  [/^victor valverde/, "Corridos"],
  [/^(chris brown)/, "R&B"],
  [/^(khea|trap capos|pepe quintana)/, "Latin Trap"],
  [/^(rosalia|manuel turizo|kevvo|mambo kingz|abraham mateo|milly|beele|klasico|revol|yng lvcas|dj snake|wizzars|louis bpm|mark b|hear this music|chyno miranda)/, "Reggaeton"],
  [/^(play n skillz|descemer bueno)/, "Latin Dance"],
  [/^(sikdope|marshmello|juan magan)/, "Dance"],
  [/^(pitbull|black eyed peas|jennifer lopez)/, "Dance Pop"],
  [/^(enrique iglesias|shakira|luis fonsi|kany garcia|ricky martin|reik|thalia|sebastian yatra|tini|pedro capo)/, "Latin Pop"],
  [/^(bad bunny|j balvin|daddy yankee|don omar|farruko|ozuna|maluma|karol g|wisin|yandel|zion|nicky jam|nio garcia|jhayco|jhay cortez|rauw alejandro|sech|becky g|natti natasha|lunay|justin quiles|jory boy|brytiago|rvssian|myke towers|arcangel|alexis|alexio|anuel aa|baby rasta|alex sensation|chris jedi|n o r e|nacho|piso 21|chino|de la ghetto|tito el bambino|tito "el bambino"|blessd)/, "Reggaeton"],
];

export function resolveMusicMetadata(track: MetadataTrack): MusicMetadata {
  const clean = cleanMusicName(track.name);
  // Canonical filename extraction wins over downloader TIT2/TPE1 copies.
  const artist = clean.artist || track.artist?.trim() || "";
  const title = (!clean.artist && track.title?.trim()) || clean.title || track.name;
  const tagged = meaningfulGenre(track.genre);
  if (track.genreSource === "owner") return { artist, title, genre: tagged, genreSource: "owner" };
  if (tagged && (!track.genreSource || track.genreSource === "tag")) return { artist, title, genre: tagged, genreSource: "tag" };
  const a = musicKey(artist), t = musicKey(title);
  if (/interview|full complete show|live medley/.test(t)) return { artist, title, genre: "", genreSource: "unknown" };
  if (!(!track.id && track.genre && !tagged)) {
    const song = SONG_GENRES.find(([ar, tr]) => ar.test(a) && tr.test(t));
    if (song) return { artist, title, genre: song[2], genreSource: "song" };
  }
  if (/\b(salsa version|salsa)\b/.test(t)) return { artist, title, genre: "Salsa", genreSource: "song" };
  if (/\bbachata\b/.test(t)) return { artist, title, genre: "Bachata", genreSource: "song" };
  const inferred = ARTIST_GENRES.find(([pattern]) => pattern.test(a));
  return { artist, title, genre: inferred?.[1] ?? "", genreSource: inferred ? "artist-estimate" : "unknown" };
}
export function musicLabel(track: MetadataTrack): string {
  const { artist, title } = resolveMusicMetadata(track);
  return artist ? `${artist} - ${title}` : title;
}
export function needsGenreReview(track: MetadataTrack): boolean {
  return ["artist-estimate", "unknown"].includes(resolveMusicMetadata(track).genreSource);
}
