// MapForge 3D — generate 3D models of real places from OpenStreetMap data.
// Original implementation. Data: © OpenStreetMap contributors (ODbL);
// elevation: Terrain Tiles on AWS (Mapzen terrarium encoding).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import polygonClipping from 'https://esm.sh/polygon-clipping@0.15.7';
import { jsPDF } from 'https://esm.sh/jspdf@2.5.1';
import { zipSync, strToU8 } from 'https://esm.sh/fflate@0.8.2';

/* ============================================================ state & layer config */

const state = {
  sizeMeters: null,  // side length (square) / diameter (circle) of the selection area
  areaShape: 'square', // Custom-mode shape: 'square' | 'circle'
  model: null,       // THREE.Group of the last generated model
  modelName: 'queens-parade-ashwood',
  last: null,        // cached fetch: {bbox, elements, sampleElev, minElev}
  mode: 'square',    // 'square' | 'suburb'
  council: null,     // selected area: { name, slug, bbox, maskRings } when mode==='suburb'
  uiMode: 'suburb',  // top toggle: 'suburb' | 'custom'
  baseData: null,    // cached inputs for rebuilding the backing map: {bbox, elements, prebaked, M}
  placeLabels: null, // { suburb, postcode } for the backing-map title (best-effort)
  frame: null,       // THREE.Group of the decorative frame (preview only)
  backdrop: null,    // THREE.Group of the backdrop wall/floor (preview only)
  titleObj: null,    // THREE.Mesh of the raised 3D title (preview + separate export)
  maxGround: 0,      // highest terrain elevation of the map, relative metres
};

// All Victorian localities (source: matthewproctor/australianpostcodes, VIC
// 'Delivery Area' entries). The slug matches the optional pre-baked footprints
// file the app looks for: buildings/<slug>.buildings.json
const SUBURBS = [
  'Abbeyard','Abbotsford','Aberfeldie','Aberfeldy','Acheron','Ada','Adams Estate','Addington','Adelaide Lead',
  'Agnes','Ailsa','Aintree','Aire Valley','Aireys Inlet','Airly','Airport West','Albacutya','Albanvale',
  'Albert Park','Alberton','Alberton West','Albion','Alexandra','Alfredton','Allambee','Allambee Reserve',
  'Allambee South','Allans Flat','Allansford','Allendale','Allestree','Alma','Almonds','Almurta','Alphington',
  'Altona','Altona East','Altona Gate','Altona Meadows','Altona North','Alvie','Amherst','Amor','Amphitheatre',
  'Anakie','Ancona','Anderson','Angip','Anglers Rest','Anglesea','Annuello','Antwerp','Apollo Bay','Appin',
  'Appin Park','Appin South','Apsley','Arapiles','Ararat','Ararat East','Arawata','Arbuckle','Arcadia',
  'Arcadia South','Archdale','Archdale Junction','Archerton','Archies Creek','Ardeer','Ardmona','Areegra','Argyle',
  'Armadale','Armadale North','Armstrong','Armstrong Creek','Arnold','Arnold West','Arthurs Creek','Arthurs Seat',
  'Ascot','Ascot Vale','Ashbourne','Ashburton','Ashwood','Aspendale','Aspendale Gardens','Athlone','Attwood',
  'Aubrey','Auburn','Auburn South','Auchmore','Avalon','Avenel','Avoca','Avon Plains','Avondale Heights','Avonmore',
  'Avonsleigh','Axe Creek','Axedale','Ayrford','Baarmutha','Bacchus Marsh','Baddaginnie','Badger Creek','Bael Bael',
  'Bagshot','Bagshot North','Bahgallah','Bailieston','Bairnsdale','Bakery Hill','Balaclava','Bald Hills',
  'Bald Rock','Balintore','Ballan','Ballangeich','Ballapur','Ballarat','Ballarat Central','Ballarat East',
  'Ballarat North','Ballarat Roadside Delivery','Ballarat West','Ballendella','Balliang','Balliang East',
  'Ballyrogan','Balmattum','Balmoral','Balnarring','Balnarring Beach','Balook','Balwyn','Balwyn East',
  'Balwyn North','Bamawm','Bamawm Extension','Bambra','Bamganie','Bandiana','Bandiana Milpo','Bangerang',
  'Bangholme','Banksia Peninsula','Bannerton','Bannockburn','Banyan','Banyena','Banyenong','Banyule','Baranduda',
  'Bareena','Barfold','Baringhup','Baringhup West','Barjarg','Barkers Creek','Barkly','Barkstead','Barmah',
  'Barnadown','Barnawartha','Barnawartha North','Baromi','Barongarook','Barongarook West','Barrabool','Barrakee',
  'Barramunga','Barraport','Barraport West','Barrys Reef','Barunah Park','Barunah Plains','Barwidgee','Barwite',
  'Barwon Downs','Barwon Heads','Basalt','Bass','Batesford','Bathumi','Batman','Baw Baw','Baw Baw Village','Baxter',
  'Bayindeen','Bayles','Baynton','Baynton East','Bayswater','Bayswater North','Beaconsfield','Beaconsfield Upper',
  'Bealiba','Bearii','Bears Lagoon','Beauchamp','Beaufort','Beaumaris','Beazleys Bridge','Bedford Road','Beeac',
  'Beech Forest','Beechworth','Beenak','Belgrave','Belgrave Heights','Belgrave South','Bell Bird Creek','Bell Park',
  'Bell Post Hill','Bellarine','Bellbird Creek','Bellbrae','Bellbridge','Bellellen','Bellfield','Bells Beach',
  'Bellview','Belmont','Belvedere Park','Bemm River','Ben Nevis','Bena','Benalla','Benalla West','Benambra',
  'Benarch','Benayeo','Bend Of Islands','Bendigo','Bendigo Forward','Bendigo South','Bendoc','Bengworden',
  'Benjeroop','Benloch','Bennettswood','Bennison','Bentleigh','Bentleigh East','Benwerrin','Beremboke','Berrambool',
  'Berrimal','Berrimal West','Berringa','Berringama','Berriwillock','Berrybank','Berrys Creek','Berwick',
  'Bessiebelle','Bet Bet','Bete Bolong','Bete Bolong North','Bethanga','Betley','Beulah','Beverford','Beveridge',
  'Big Desert','Big Hill','Big Pats Creek','Biggara','Billabong','Bimbourie','Bindi','Binginwarri','Bingo',
  'Bingo Munjie','Birchip','Birchip West','Birdwoodton','Birregurra','Bittern','Black Hill','Black Range',
  'Black Rock','Black Rock North','Blackburn','Blackburn North','Blackburn South','Blackheath','Blackwarry',
  'Blackwood','Blackwood Forest','Blairgowrie','Blakeville','Blampied','Blind Bight','Blowhard','Bo Peep',
  'Bobinawarrah','Bochara','Bogong','Boho','Boho South','Boigbeat','Boinka','Boisdale','Bolangum','Bolinda',
  'Bolton','Bolwarra','Bolwarrah','Bona Vista','Bonang','Bonbeach','Bonegilla','Boneo','Bonn','Bonnie Brook',
  'Bonnie Doon','Bonshaw','Bookaar','Boola','Boolarong','Boolarra','Boolarra South','Boole Poole','Boolite',
  'Boomahnoomoonah','Boonah','Booran Road Po','Boorcan','Boorhaman','Boorhaman East','Boorhaman North','Boorolite',
  'Boorool','Boort','Boosey','Boralma','Bornes Hill','Boronia','Borung','Bostocks Creek','Botanic Ridge',
  'Boundary Bend','Bowenvale','Boweya','Boweya North','Bowmans Forest','Bowser','Box Hill','Box Hill Central',
  'Box Hill North','Box Hill South','Boxwood','Bradford','Bradvale','Braeside','Branditt','Brandon Park',
  'Brandy Creek','Branxholme','Bravington','Braybrook','Braybrook North','Breakaway Creek','Breakwater','Breamlea',
  'Brenanah','Brentford Square','Brewster','Briagolong','Briar Hill','Bridge Creek','Bridge Inn','Bridgewater',
  'Bridgewater North','Bridgewater On Loddon','Bright','Brighton','Brighton East','Brighton North','Brighton Road',
  'Brim','Brimboal','Brimin','Brimpaen','Bringalbert','Brit Brit','Broadford','Broadlands','Broadmeadows',
  'Broadwater','Brodribb River','Broken Creek','Bromley','Brookfield','Brooklyn','Brookville','Broomfield',
  'Broughton','Brown Hill','Browns Plains','Bruarong','Bruces Creek','Brucknell','Brumby','Brunswick',
  'Brunswick East','Brunswick Lower','Brunswick North','Brunswick South','Brunswick West','Bruthen','Buangor',
  'Buchan','Buchan South','Buckland','Buckley','Buckley Swamp','Buckrabanyule','Budgee Budgee','Budgeree',
  'Budgeree East','Budgerum East','Buffalo','Buffalo Creek','Buffalo River','Bulart','Buldah','Bulga','Bulgana',
  'Bulla','Bullabul','Bullaharre','Bullarook','Bullarto','Bullarto South','Bulleen','Bulleen South','Bullengarook',
  'Bullioh','Bullumwaal','Buln Buln','Buln Buln East','Bumberrah','Bunbartha','Bundalaguah','Bundalong',
  'Bundalong South','Bundara','Bunding','Bundoora','Bung Bong','Bungador','Bungal','Bungalally','Bungaree',
  'Bungeet','Bungeet West','Bungil','Bunguluke','Buninyong','Bunkers Hill','Bunyip','Bunyip North','Buragwonduc',
  'Burkes Bridge','Burkes Flat','Burnbank','Burnewang','Burnley','Burnley North','Burnside','Burnside Heights',
  'Burramboot','Burramine','Burramine South','Burrowye','Burrumbeet','Burwood','Burwood East','Burwood Heights',
  'Bushfield','Bushy Park','Butchers Ridge','Buxton','Byaduk','Byaduk North','Byawatha','Byrneside','Cabanandra',
  'Cabarita','Cabbage Tree','Cabbage Tree Creek','Cadello','Cairnlea','Calder Park','Caldermeade',
  'California Gully','Calivil','Callawadda','Callignee','Callignee North','Callignee South','Calrossie','Calulu',
  'Cambarville','Camberwell','Camberwell East','Camberwell North','Camberwell South','Camberwell West',
  'Cambrian Hill','Campaspe West','Campbellfield','Campbells Bridge','Campbells Creek','Campbells Forest',
  'Campbelltown','Camperdown','Canadian','Canary Island','Caniambo','Cann River','Cannie','Cannons Creek','Cannum',
  'Canterbury','Cape Bridgewater','Cape Clear','Cape Conran','Cape Otway','Cape Paterson','Cape Schanck',
  'Cape Woolamai','Capel Sound','Capels Crossing','Carag Carag','Caralulup','Caramut','Carapooee','Carapooee West',
  'Carapook','Carboor','Cardigan','Cardigan Village','Cardinia','Cardross','Cargerie','Carina','Caringal',
  'Carisbrook','Carlisle River','Carlsruhe','Carlton','Carlton North','Carlton South','Carlyle','Carnegie',
  'Carngham','Caroline Springs','Carpendeit','Carrajung','Carrajung Lower','Carrajung South','Carranballac',
  'Carron','Carrum','Carrum Downs','Carwarp','Cashmore','Cassilis','Castella','Casterton','Castle Creek',
  'Castle Donnington','Castleburn','Castlemaine','Catani','Cathcart','Cathkin','Catumnal','Caulfield',
  'Caulfield East','Caulfield Junction','Caulfield North','Caulfield South','Caveat','Cavendish','Central Park',
  'Ceres','Chadstone','Chadstone Centre','Chandlers Creek','Chapel Flat','Chapel Street North','Chapple Vale',
  'Charam','Charlemont','Charleroi','Charlton','Chartwell','Chatsworth','Chelsea','Chelsea Heights','Cheltenham',
  'Cheltenham East','Cheltenham North','Chepstowe','Cherokee','Cherrilong','Cherrypool','Cheshunt','Cheshunt South',
  'Chesney Vale','Chetwynd','Chewton','Chewton Bushlands','Childers','Chillingollah','Chiltern','Chiltern Valley',
  'Chinangin','Chinkapook','Chintin','Chirnside Park','Chirrip','Chocolyn','Christies','Christmas Hills',
  'Chum Creek','Churchill','Churchill Island','Chute','Clarendon','Claretown','Clarinda','Clarkefield',
  'Clarkes Hill','Clayton','Clayton South','Clear Lake','Clematis','Clifton Creek','Clifton Hill','Clifton Springs',
  'Clonbinane','Clover Flat','Cloverlea','Club Terrace','Clunes','Clyde','Clyde North','Clydebank','Clydesdale',
  'Coalville','Coatesville','Cobains','Cobaw','Cobbannah','Cobberas','Cobblebank','Cobden','Cobram','Cobram East',
  'Cobrico','Cobungra','Coburg','Coburg North','Cocamba','Cochranes Creek','Cockatoo','Cocoroc','Codrington',
  'Coghills Creek','Cohuna','Coimadai','Cokum','Colac','Colac Colac','Colac East','Colac West','Colbinabbin',
  'Colbrook','Coldstream','Coleraine','Colignan','Collingwood','Collingwood North','Colliver','Combienbar',
  'Comet Hill','Concongella','Condah','Condah Swamp','Congupna','Connangorach','Connewarre','Connewirricoo',
  'Coojar','Coolaroo','Cooma','Coomboona','Coomoora','Coongulla','Coonooer Bridge','Coonooer West','Coopers Creek',
  'Cooriemungle','Cope Cope','Cora Lynn','Corack','Corack East','Coragulac','Coral Bank','Corindhap','Corinella',
  'Corio','Corndale','Cornelia Creek','Cornella','Cornishtown','Coronet Bay','Corop','Corop West','Cororooke',
  'Corringle','Corryong','Corunnun','Cosgrove','Cosgrove South','Costerfield','Cotham','Cotswold','Cottles Bridge',
  'Cowa','Cowangie','Cowes','Cowleys Creek','Cowwarr','Craigie','Craigieburn','Cranbourne','Cranbourne East',
  'Cranbourne North','Cranbourne South','Cranbourne West','Creek Junction','Creek View','Creighton',
  'Creightons Creek','Cremorne','Cressy','Creswick','Creswick North','Crib Point','Cromer','Crookayan',
  'Crooked River','Cross Keys','Cross Roads','Crossley','Crossover','Crowlands','Croxton East','Croydon',
  'Croydon Hills','Croydon North','Croydon South','Crymelon','Crystal Creek','Cudgee','Cudgewa','Culgoa','Culla',
  'Cullen','Cullulleraine','Cundare','Cundare North','Curdie Vale','Curdies River','Curdievale','Curlewis','Curyo',
  'Dadswells Bridge','Dahlen','Daisy Hill','Dales Creek','Dallas','Dalmore','Daltons Bridge','Dalyenong','Dalyston',
  'Dandenong','Dandenong East','Dandenong North','Dandenong South','Dandongadale','Dargo','Darkbonee','Darley',
  'Darlimurla','Darling','Darling South','Darlington','Darnum','Darraweit Guim','Darriman','Dartmoor','Dartmouth',
  'Dawson','Daylesford','Deakin University','Dean','Deans Marsh','Deanside','Deddick Valley','Dederang','Deep Lead',
  'Deepdene','Deer Park','Deer Park East','Deer Park North','Delacombe','Delahey','Delatite','Delburn',
  'Delegate River','Delegate River East','Dellicknora','Dendy','Denicull Creek','Denison','Dennington','Denver',
  'Deptford','Derby','Dereel','Dergholm','Derrimut','Derrinal','Derrinallum','Devenish','Devils River',
  'Devon Meadows','Devon North','Dewhurst','Dhurringile','Diamond Creek','Diamond Hill','Digby','Diggers Rest',
  'Diggora','Diggora West','Dimboola','Dingee','Dingley Village','Dingwall','Dinner Plain','Dixie','Dixons Creek',
  'Dobie','Docker','Dockers Plains','Docklands','Doctors Flat','Dollar','Domain Road Po','Don Valley','Donald',
  'Doncaster','Doncaster East','Doncaster Heights','Donnybrook','Donvale','Dooboobetic','Dooen','Dookie','Doreen',
  'Dorodong','Double Bridges','Douglas','Doveton','Dreeite','Dreeite South','Driffield','Drik Drik','Dromana',
  'Dropmore','Drouin','Drouin East','Drouin South','Drouin West','Drumanure','Drumborg','Drumcondra','Drummartin',
  'Drummond','Drummond North','Drung','Dry Diggings','Drysdale','Duchembegarra','Dugays Bridge','Dumbalk',
  'Dumbalk North','Dumosa','Dunach','Dundonnell','Dunearn','Dunkeld','Dunkirk','Dunluce','Dunneworthy','Dunnstown',
  'Dunolly','Dunrobin','Durdidwarrah','Durham Lead','Durham Ox','Dutson','Dutson Downs','Dutton Way','Duverney',
  'Dysart','Eagle Point','Eaglehawk','Eaglehawk North','Eaglemont','Earlston','East Bairnsdale','East Bendigo',
  'East Geelong','East Melbourne','East Sale','East Sale RAAF','East Wangaratta','East Warburton','East Yeoburn',
  'Eastern View','Eastville','Eastwood','Ebden','Echuca','Echuca East','Echuca South','Echuca Village',
  'Echuca West','Ecklin South','Eddington','Eden Park','Edenhope','Edgecombe','Edi','Edi Upper','Edithvale',
  'Eganstown','Eildon','Elaine','Elberton','Eldorado','Elevated Plains','Elingamite','Elingamite North',
  'Elizabeth Island','Ellaswood','Ellerslie','Elliminyt','Ellinbank','Elmhurst','Elmore','Elphinstone',
  'Elsternwick','Eltham','Eltham North','Elwood','Emerald','Emu','Emu Creek','Emu Flat','Endeavour Hills','Enfield',
  'Englefield','Enochs Point','Ensay','Ensay North','Eppalock','Epping','Epsom','Ercildoune','Erica','Errinundra',
  'Eskdale','Esmond','Essendon','Essendon Fields','Essendon North','Essendon West','Eumemmerring','Eurack','Eureka',
  'Euroa','Eurobin','Evansford','Eversley','Everton','Everton Upper','Exford','Eynesbury','Fairbank','Fairfield',
  'Fairhaven','Fairley','Fairy Dell','Falls Creek','Faraday','Fawcett','Fawkner','Fawkner East','Fawkner North',
  'Fentons Creek','Ferguson','Fern Hill','Fernbank','Ferndale','Fernihurst','Fernshaw','Ferntree Gully','Fernvale',
  'Ferny Creek','Fieldstone','Fiery Flat','Fingal','Fish Creek','Fish Point','Fiskville','Fitzroy','Fitzroy North',
  'Five Ways','Flaggy Creek','Flagstaff','Flamingo Beach','Flemington','Flinders','Flora Hill','Flowerdale','Flynn',
  'Flynns Creek','Footscray','Forbes','Forest Hill','Forge Creek','Forrest','Foster','Foster North','Fosterville',
  'Fountain Gate','Foxhow','Framlingham','Framlingham East','Franklinford','Frankston','Frankston East',
  'Frankston Heights','Frankston North','Frankston South','Fraser Rise','Freeburgh','French Island','Frenchmans',
  'Freshwater Creek','Fryerstown','Fulham','Fumina','Fumina South','Fyans Creek','Fyansford','Gaffneys Creek',
  'Gainsborough','Gannawarra','Gapsted','Garden City','Gardenvale','Garfield','Garfield North','Garibaldi','Garvoc',
  'Gateway Island','Gatum','Gazette','Geelong','Geelong North','Geelong West','Gelantipy','Gellibrand',
  'Gellibrand Lower','Gelliondale','Gembrook','Genoa','Gentle Annie','Georges Creek','Gerahmin','Gerang Gerung',
  'Gerangamete','Germania','Germantown','Gerrigerrup','Gherang','Gheringhap','Ghin Ghin','Giffard','Giffard West',
  'Gil Gil','Gilberton','Gilderoy','Gillieston','Gillum','Gipsy Point','Girgarre','Girgarre East','Gisborne',
  'Gisborne South','Gladfield','Gladstone Park','Gladysdale','Glen Alvie','Glen Creek','Glen Falloch','Glen Forbes',
  'Glen Huntly','Glen Iris','Glen Park','Glen Valley','Glen Waverley','Glen Wills','Glenaire','Glenaladale',
  'Glenalbyn','Glenaroua','Glenbrae','Glenburn','Glendaruel','Glendonald','Glendonnell','Glenfalloch',
  'Glenferrie South','Glenfyne','Glengala','Glengarry','Glengarry North','Glengarry West','Glengower','Glenhope',
  'Glenhope East','Glenisla','Glenlee','Glenlofty','Glenlogie','Glenloth','Glenloth East','Glenluce','Glenlyon',
  'Glenmaggie','Glenmore','Glenorchy','Glenormiston','Glenormiston North','Glenormiston South','Glenpatrick',
  'Glenrowan','Glenrowan West','Glenroy','Glenthompson','Glomar Beach','Gnarwarre','Gnotuk','Gobarup','Gobur',
  'Golden Beach','Golden Gully','Golden Point','Golden Square','Goldie','Goldsborough','Gong Gong','Gonn Crossing',
  'Goomalibee','Goon Nure','Goongerah','Gooram','Gooramadda','Goorambat','Goornong','Gooroc','Gorae','Gorae West',
  'Gordon','Gormandale','Goroke','Goschen','Goughs Bay','Goulburn Weir','Gowanbrae','Gowanford','Gowangardie',
  'Gowar East','Gower','Grahamvale','Grampians','Grand Ridge','Grangefields','Granite Flat','Granite Rock',
  'Grantville','Granya','Grass Flat','Grassdale','Grassmere','Grassy Spur','Grays Bridge','Graytown','Gre Gre',
  'Gre Gre North','Gre Gre South','Great Southern','Great Western','Gredgwin','Green Gully','Green Lake',
  'Greendale','Greenhill','Greens Creek','Greensborough','Greenvale','Greenwald','Grenville','Greta','Greta South',
  'Greta West','Grey River','Greythorn','Gringegalgona','Gritjurk','Grovedale','Grovedale East','Gruyere',
  'Guildford','Gunbower','Gundowring','Gunyah','Guthridge','Guys Forest','Guys Hill','Gymbowen','Haddon','Hadfield',
  'Hallam','Hallora','Halls Gap','Hallston','Hamilton','Hamlyn Heights','Hampton','Hampton East','Hampton North',
  'Hampton Park','Hanging Rock','Hansonville','Happy Valley','Harcourt','Harcourt North','Harkaway','Harkness',
  'Harmers Haven','Harrietville','Harrow','Harston','Hartwell','Hastings','Hattah','Havelock','Haven','Havilah',
  'Havillah','Hawkesdale','Hawkhurst','Hawksburn','Hawthorn','Hawthorn East','Hawthorn North','Hawthorn West',
  'Haydens Bog','Hazel Park','Hazeldene','Hazelwood','Hazelwood North','Hazelwood South','Healesville',
  'Healesville Main Street','Healesville Post Shop','Heath Field','Heath Hill','Heathcote','Heathcote Junction',
  'Heathcote South','Heatherton','Heathmere','Heathmont','Heathwood','Hedley','Heidelberg','Heidelberg Heights',
  'Heidelberg Rgh','Heidelberg West','Hensley Park','Henty','Hepburn','Hepburn Springs','Herne Hill','Hernes Oak',
  'Hesket','Hesse','Hexham','Heyfield','Heytesbury Lower','Heywood','Hiamdale','Hiawatha','Hicksborough',
  'Hidden Valley','High Camp','Highett','Highlands','Highpoint City','Highton','Hilgay','Hill End','Hillcrest',
  'Hilldene','Hillside','Hinnomunjie','Hoddle','Hoddles Creek','Hollands Landing','Holmesglen','Homebush',
  'Homerton','Homewood','Hopetoun','Hopetoun Gardens','Hopetoun Park','Hopevale','Hoppers Crossing','Hordern Vale',
  'Horfield','Horsham','Horsham West','Hotham Heights','Hotham Hill','Hotspur','Houston','Howes Creek',
  'Howitt Plains','Howqua','Howqua Hills','Howqua Inlet','Hughesdale','Hume Weir','Humevale','Hunter','Hunterston',
  'Huntingdale','Huntly','Huntly North','Huon','Huon Creek','Hurdle Flat','Hurstbridge','Icy Creek','Iguana Creek',
  'Illabarook','Illawarra','Illowa','Indented Head','Indigo','Indigo Upper','Indigo Valley','Inglewood','Ingliston',
  'Inkerman','Invergordon','Invergordon South','Inverleigh','Inverloch','Invermay','Invermay Park','Iona','Iraak',
  'Irishtown','Ironbark','Irrewarra','Irrewillipe','Irrewillipe East','Irymple','Ivanhoe','Ivanhoe East',
  'Ivanhoe North','Jacana','Jack River','Jackass Flat','Jacob Creek','Jallakin','Jallukur','Jallumba','Jam Jerrup',
  'Jamieson','Jan Juc','Jancourt','Jancourt East','Jarklin','Jarrahmond','Jarvis Creek','Jeeralang',
  'Jeeralang Junction','Jeetho','Jeffcott','Jeffcott North','Jeparit','Jericho','Jeruk','Jil Jil','Jilpanger',
  'Jindivick','Joel Joel','Joel South','Johanna','Johnsonville','Johnstones Hill','Jordanville','Joyces Creek',
  'Jumbuk','Jumbunna','Junction Village','Jung','Jungaburra','Junortoun','Kaarimba','Kadnook','Kalimna',
  'Kalimna West','Kalkallo','Kalkee','Kallista','Kalorama','Kalpienung','Kamarooka','Kamarooka North','Kanagulk',
  'Kancoona','Kancoona South','Kangaroo Flat','Kangaroo Ground','Kaniva','Kanumbra','Kanya','Kanyapella','Karabeal',
  'Kardella','Kardella South','Kariah','Karingal','Karingal Centre','Karnak','Karramomus','Karyrie','Katamatite',
  'Katamatite East','Katandra','Katandra West','Katunga','Kawarren','Kealba','Keely','Keilor','Keilor Downs',
  'Keilor East','Keilor Lodge','Keilor North','Keilor Park','Kellalac','Kelvin View','Kenley','Kenmare',
  'Kennedys Creek','Kennett River','Kennington','Kensington','Keon Park','Kerang','Kerang East','Kergunyah',
  'Kergunyah South','Kernot','Kerrie','Kerrimuir','Kerrisdale','Kevington','Kew','Kew East','Kewell','Keysborough',
  'Kialla','Kialla East','Kialla West','Kiata','Kiewa','Kilcunda','Kilfeera','Killara','Killarney','Killawarra',
  'Killingworth','Kilmany','Kilmore','Kilmore East','Kilsyth','Kilsyth South','Kimbolton','King Valley','Kinglake',
  'Kinglake Central','Kinglake West','Kingower','Kings Park','Kingsbury','Kingston','Kingsville','Kingsville West',
  'Kinnabulla','Kinypanial','Kirkstall','Kirwans Bridge','Kithbrook','Knebsworth','Knockwood','Knowsley',
  'Knox City Centre','Knoxfield','Koallah','Kobyboyn','Koetong','Kolora','Kongwak','Konongwootong','Koo Wee Rup',
  'Koo Wee Rup North','Kooloonong','Koonda','Koondrook','Koonoomoo','Koonwarra','Kooreh','Koorlong','Koornalla',
  'Kooroocheang','Koorool','Koorooman','Kooyong','Koriella','Korobeit','Koroit','Korong Vale','Koroop','Korrine',
  'Korumburra','Korumburra South','Korweinguboora','Kotta','Kotupna','Koyuga','Koyuga South','Krowera','Kulwin',
  'Kunat','Kunyung','Kurraca','Kurraca West','Kurting','Kurunjang','Ky Valley','Ky West','Kyabram','Kyabram South',
  'Kyneton','Kyneton South','Kyvalley','La Trobe University','Laanecoorie','Laang','Labertouche','Laburnum',
  'Laceby','Ladys Pass','Laen','Laen East','Laen North','Lah','Laharum','Lake Boga','Lake Bolac','Lake Buloke',
  'Lake Bunga','Lake Charm','Lake Condah','Lake Eildon','Lake Eppalock','Lake Fyans','Lake Gardens',
  'Lake Goldsmith','Lake Hindmarsh','Lake Lonsdale','Lake Marmal','Lake Meran','Lake Mokoan','Lake Moodemere',
  'Lake Mundi','Lake Powell','Lake Rowan','Lake Tyers','Lake Tyers Beach','Lake Tyrrell','Lake Wellington',
  'Lake Wendouree','Lake Wongan','Lakes Entrance','Lal Lal','Lalbert','Lalor','Lalor Plaza','Lamplough','Lancaster',
  'Lance Creek','Lancefield','Landsborough','Landsborough West','Lang Lang','Lang Lang East','Langdons Hill',
  'Langi Kal Kal','Langi Logan','Langkoop','Langley','Langsborough','Langwarrin','Langwarrin South','Lansell Plaza',
  'Lara','Lardner','Larpent','Larralea','Lascelles','Launching Place','Lauriston','Lavers Hill','Laverton',
  'Laverton North','Laverton RAAF','Lawler','Lawloit','Lawrence','Leaghur','Learmonth','Ledcourt','Leichardt',
  'Leigh Creek','Leitchville','Lemnos','Leneva','Leonards Hill','Leongatha','Leongatha North','Leongatha South',
  'Leopold','Lerderderg','Leslie Manor','Lethbridge','Lexton','Licola','Licola North','Lillico','Lillicur',
  'Lillimur','Lilliput','Lilydale','Lima','Lima East','Lima South','Limestone','Limonite','Lindenow',
  'Lindenow South','Lindsay','Lindsay Point','Linga','Linton','Liparoo','Lismore','Litchfield','Little Desert',
  'Little Hampton','Little River','Llanelly','Llowalong','Loch','Loch Sport','Loch Valley','Lochend','Lockington',
  'Locksley','Lockwood','Lockwood South','Loddon Vale','Logan','Londrigan','Lone Pine','Long Forest','Long Gully',
  'Longerenong','Longford','Longlea','Longwarry','Longwarry North','Longwood','Longwood East','Lorne','Lorquon',
  'Lovely Banks','Lower Moira','Lower Norton','Lower Plenty','Loy Yang','Lubeck','Lucas','Lucknow','Lucyvale',
  'Lurg','Lyal','Lygon Street North','Lynbrook','Lyndale','Lyndhurst','Lyons','Lyonville','Lysterfield',
  'Lysterfield South','Macarthur','Macclesfield','Macedon','Macks Creek','Macleod','Macleod West','Macorna',
  'Macorna North','Macs Cove','Madalya','Maddingley','Mafeking','Maffra','Maffra West Upper','Magpie',
  'Maiden Gully','Maidstone','Mailer Flat','Mailors Flat','Main Lead','Main Ridge','Maindample','Maintongoon',
  'Major Plains','Majorca','Maldon','Mallacoota','Malmsbury','Malvern','Malvern East','Malvern North','Mambourin',
  'Manangatang','Mandurang','Mandurang South','Mangalore','Manifold Heights','Mannerim','Mannibadar','Manns Beach',
  'Manor Lakes','Manorina','Mansfield','Maramingo Creek','Marcus Hill','Mardan','Marengo','Maribyrnong',
  'Marionvale','Markwood','Marlbed','Marlo','Marnoo','Marnoo East','Marnoo West','Marong','Maroona','Marraweeney',
  'Marshall','Marthavale','Martins Creek','Marungi','Maryborough','Maryknoll','Marysville','Maryvale','Massey',
  'Matlock','Maude','Mayreef','McCrae','McEvoys','McIntyre','McKenzie Creek','McKenzie Hill','McKinnon',
  'McLoughlins Beach','McMahons Creek','McMillans','Mead','Meadow Creek','Meadow Heights','Meatian','Medlyn',
  'Meeniyan','Meereek','Meering West','Meerlieu','Melbourne','Melbourne Airport','Melbourne University','Melton',
  'Melton South','Melton West','Melville Forest','Melwood','Mena Park','Mentone','Mentone East','Menzies Creek',
  'Mepunga','Mepunga East','Mepunga West','Merbein','Merbein South','Merbein West','Meredith','Meringur','Merino',
  'Merlynston','Mernda','Merriang','Merriang South','Merricks','Merricks Beach','Merricks North','Merrigum',
  'Merrijig','Merrimu','Merrinee','Merton','Metcalfe','Metcalfe East','Metung','Mewburn Park','Mia Mia','Mickleham',
  'Mid Valley','Middle Camberwell','Middle Creek','Middle Park','Middle Tarwin','Miepoll','Miga Lake','Milawa',
  'Mildura','Mildura Centre Plaza','Mildura East','Mildura South','Mildura West','Mill Park','Millbrook',
  'Millgrove','Milloo','Milltown','Milnes Bridge','Mincha','Mincha West','Miners Rest','Mingay','Minhamite',
  'Minimay','Mininera','Minjah','Minmindie','Minto','Minyip','Miowera','Miralie','Miram','Mirboo','Mirboo East',
  'Mirboo North','Mirboo South','Mirimbah','Mirranatwa','Mitcham','Mitcham North','Mitchell Park','Mitchells Hill',
  'Mitchellstown','Mitiamo','Mitre','Mitta Mitta','Mittyack','Mockinya','Modella','Modewarre','Moe','Moe South',
  'Moggs Creek','Moglonemby','Mokepilly','Molesworth','Moliagul','Molka','Mollongghip','Mologa','Molyullah',
  'Monash University','Monbulk','Mongans Bridge','Monomak','Monomeith','Mont Albert','Mont Albert North',
  'Montgomery','Montmorency','Montrose','Moolap','Moolerr','Moolort','Moonambel','Moondarra','Moonee Ponds',
  'Moonee Vale','Moonlight Flat','Moora','Moorabbin','Moorabbin Airport','Moorabbin East','Moorabool','Mooralla',
  'Moorilim','Moormbool West','Moornapa','Moorngag','Moorooduc','Mooroolbark','Mooroopna','Mooroopna North',
  'Mooroopna North West','Moranding','Morang South','Mordialloc','Mordialloc North','Moreland','Moreland West',
  'Morgiana','Moriac','Mornington','Moroka','Morrisons','Morrl Morrl','Mortchup','Mortlake','Morton Plains',
  'Morwell','Morwell East','Morwell Upper','Mosquito Creek','Mossiface','Mount Alfred','Mount Beauty',
  'Mount Beckworth','Mount Best','Mount Bolton','Mount Bruno','Mount Buffalo','Mount Buller','Mount Burnett',
  'Mount Bute','Mount Camel','Mount Cameron','Mount Clear','Mount Cole','Mount Cole Creek','Mount Cottrell',
  'Mount Dandenong','Mount Doran','Mount Dryden','Mount Duneed','Mount Eccles','Mount Eccles South','Mount Egerton',
  'Mount Eliza','Mount Emu','Mount Evelyn','Mount Franklin','Mount Glasgow','Mount Helen','Mount Hooghly',
  'Mount Hotham','Mount Lonarch','Mount Macedon','Mount Major','Mount Martha','Mount Mercer','Mount Mitchell',
  'Mount Moriac','Mount Napier','Mount Pleasant','Mount Prospect','Mount Richmond','Mount Rowan','Mount Sabine',
  'Mount Scobie','Mount Slide','Mount Tassie','Mount Taylor','Mount Toolebewong','Mount Wallace','Mount Waverley',
  'Mountain Bay','Mountain Gate','Mountain View','Moutajup','Moyarra','Moyhu','Moyreisk','Moyston','Mt Baw Baw',
  'Muckatah','Muckleford','Muckleford South','Mudgegonga','Mulgrave','Mumbannar','Mundoona','Munro','Muntham',
  'Murchison','Murchison East','Murchison North','Murgheboluc','Murmungee','Murnungin','Murphys Creek',
  'Murra Warra','Murrabit','Murrabit West','Murrawee','Murray-Sunset','Murraydale','Murrayville','Murrindal',
  'Murrindindi','Murroon','Murrumbeena','Murtoa','Musk','Musk Vale','Muskerry','Muskerry East','Myall','Myamyn',
  'Myers Flat','Myola','Myola East','Myrniong','Myrrhee','Myrtle Creek','Myrtlebank','Myrtleford','Mysia',
  'Mystic Park','Mywee','Nagambie','Nalangil','Nalinga','Nambrok','Nandaly','Nangana','Nangeela','Nangiloc',
  'Nanneella','Nap Nap Marra','Napoleons','Nar Nar Goon','Nar Nar Goon North','Narbethong','Nareeb','Nareen',
  'Nareewillock','Nariel Valley','Naring','Naringal','Naringal East','Naroghid','Narracan','Narraport',
  'Narrapumelap South','Narrawong','Narre Warren','Narre Warren East','Narre Warren North','Narre Warren South',
  'Narrung','Nathalia','Natimuk','Natte Yallock','Natya','Navarre','Navigators','Nayook','Neds Corner','Neereman',
  'Neerim','Neerim East','Neerim Junction','Neerim North','Neerim South','Neilborough','Nelse','Nelson','Nerrena',
  'Nerrin Nerrin','Nerrina','Nerring','Netherby','Neuarpurr','New Gisborne','Newborough','Newborough East',
  'Newbridge','Newbury','Newcomb','Newfield','Newham','Newhaven','Newington','Newlands Arm','Newlyn','Newlyn North',
  'Newmerella','Newport','Newry','Newstead','Newtown','Nhill','Nichols Point','Nicholson','Niddrie','Niddrie North',
  'Nillahcootie','Nilma','Nilma North','Ninda','Nine Mile','Nintingbool','Ninyeunook','Nirranda','Nirranda East',
  'Nirranda South','Noble Park','Noble Park East','Noble Park North','Noojee','Noorat','Noorat East','Noorinbee',
  'Noorinbee North','Noradjuha','Norlane','Normanville','Norong','Norong Central','North Bendigo','North Blackwood',
  'North Geelong','North Melbourne','North Pole','North Road','North Shore','North Wangaratta','North Warrandyte',
  'North Wonthaggi','Northcote','Northcote South','Northland Centre','Northwood','Norval','Notting Hill',
  'Nowa Nowa','Nowhere Creek','Nowie','Nug Nug','Nuggetty','Nulla Vale','Nullawarre','Nullawarre East',
  'Nullawarre North','Nullawil','Numurkah','Nunawading','Nungurner','Nunniong','Nuntin','Nurcoung','Nurrabiel',
  'Nurran','Nutfield','Nyah','Nyah West','Nyarrin','Nyerimilang','Nyora','Nyrraby','Oak Park','Oaklands Junction',
  'Oakleigh','Oakleigh East','Oakleigh South','Oakvale','Ocean Grange','Ocean Grove','Officer','Officer South',
  'Old Tallangatta','Olinda','Ombersley','Omeo','Omeo Valley','Ondit','Orbost','Orford','Ormond','Orrvale',
  'Osbornes Flat','Outtrim','Ouyen','Ovens','Oxley','Oxley Flats','Ozenkadnook','Paaratte','Painswick','Pakenham',
  'Pakenham South','Pakenham Upper','Panitya','Panmure','Panton Hill','Paradise','Paradise Beach','Paraparap',
  'Park Orchards','Parkdale','Parkville','Parkwood','Parwan','Paschendale','Pascoe Vale','Pascoe Vale South',
  'Pastoria','Pastoria East','Patchewollock','Patho','Patho West','Patterson','Patterson Lakes','Patyah',
  'Paynesville','Pearcedale','Pearsondale','Peechelba','Peechelba East','Pelluebla','Pennyroyal','Penshurst',
  'Pental Island','Pentland Hills','Percydale','Perkins Reef','Peronne','Perry Bridge','Peterborough',
  'Petticoat Creek','Pheasant Creek','Piangil','Piavella','Picola','Picola West','Piedmont','Pier Milan',
  'Pigeon Ponds','Piggoreet','Pilchers Bridge','Pimpinio','Pine Grove','Pine Grove East','Pine Lodge',
  'Pine Mountain','Pine View','Pines Forest','Pinewood','Pioneer Bay','Pipers Creek','Pira','Piries',
  'Pirron Yallock','Pitfield','Pittong','Plenty','Plumpton','Point Cook','Point Leo','Point Lonsdale',
  'Point Wilson','Polisbet','Pomborneit','Pomborneit East','Pomborneit North','Pomonal','Pompapiel','Poolaijelo',
  'Pootilla','Poowong','Poowong East','Poowong North','Porcupine Flat','Porcupine Ridge','Porepunkah','Port Albert',
  'Port Campbell','Port Fairy','Port Franklin','Port Melbourne','Port Welshpool','Portarlington','Portland',
  'Portland North','Portland West','Portsea','Pound Creek','Powelltown','Powers Creek','Powlett Plains',
  'Powlett River','Prahran','Prahran East','Prairie','Pranjip','Prentice North','Preston','Preston Lower',
  'Preston South','Preston West','Princes Hill','Princetown','Puckapunyal','Puckapunyal Milpo','Pura Pura',
  'Puralka','Purdeet','Purnim','Purnim West','Pyalong','Pyramid Hill','Quambatook','Quandong','Quantong',
  'Quarry Hill','Queenscliff','Queensferry','Raglan','Rainbow','Ranceby','Rangeview','Rathscar','Rathscar West',
  'Ravenhall','Ravenswood','Ravenswood South','Rawson','Raymond Island','Raywood','Red Bluff','Red Cliffs',
  'Red Hill','Red Hill South','Red Lion','Redan','Redbank','Redcastle','Redesdale','Reedy Creek','Reedy Dam',
  'Reedy Flat','Reedy Lake','Reefton','Regent West','Remlaw','Research','Reservoir','Reservoir East',
  'Reservoir North','Reservoir South','Reynard','Rheola','Rhyll','Rhymney','Riachella','Rich Avon','Rich Avon East',
  'Rich Avon West','Richmond','Richmond East','Richmond North','Richmond Plains','Richmond South','Riddells Creek',
  'Riggs Creek','Ringwood','Ringwood East','Ringwood North','Ripplebrook','Rippleside','Ripponhurst','Ripponlea',
  'Riverside','Riverslea','Robertsons Beach','Robinson','Robinvale','Robinvale Irrigation District Section B',
  'Robinvale Irrigation District Section C','Robinvale Irrigation District Section D',
  'Robinvale Irrigation District Section E','Rochester','Rochester West','Rochford','Rockbank','Rocklands',
  'Rocklyn','Rocky Point','Rodborough','Rokeby','Rokewood','Rokewood Junction','Romsey','Rosanna','Rose River',
  'Rosebery','Rosebrook','Rosebud','Rosebud Plaza','Rosebud West','Rosedale','Roses Gap','Rosewhite','Roslynmead',
  'Ross Creek','Rossbridge','Rostron','Rowsley','Rowville','Roxburgh Park','Royal Melbourne Hospital','Rubicon',
  'Ruby','Ruffy','Rumbug','Running Creek','Runnymede','Rupanyup','Rushworth','Russells Bridge','Rutherglen','Ryans',
  'Ryanston','Rye','Rythdale','Safety Beach','Sailors Falls','Sailors Gully','Sailors Hill','Saint Helena','Sale',
  'Sale East RAAF','Sale North','Salisbury West','Samaria','San Remo','Sandford','Sandhill Lake','Sandhurst',
  'Sandhurst East','Sandon','Sandown Village','Sandringham','Sandy Creek','Sandy Point','Sargood','Sarsfield',
  'Sassafras','Sassafras Gully','Sawmill Settlement','Scarsdale','Scoresby','Scotchmans Lead','Scotsburn',
  'Scotsmans Lead','Scotts Creek','Sea Lake','Seabrook','Seacombe','Seaford','Seaholme','Seaspray','Seaton',
  'Seaview','Sebastian','Sebastopol','Seddon','Seddon West','Sedgwick','Selby','Selwyn','Separation Creek',
  'Serpentine','Serviceton','Seville','Seville East','Seymour','Seymour South','Shady Creek','Shallow Inlet',
  'Shannonvale','Shays Flat','She Oaks','Sheans Creek','Sheep Hills','Shelbourne','Shelford','Shelley',
  'Shepherds Flat','Shepparton','Shepparton East','Shepparton North','Shepparton South','Sherbrooke','Shirley',
  'Shoreham','Sidonia','Silvan','Silver Creek','Silverleaves','Simmie','Simpson','Simpsons Creek','Simson',
  'Skenes Creek','Skenes Creek North','Skibo','Skinners Flat','Skipton','Skye','Slaty Creek','Smeaton',
  'Smiths Beach','Smiths Gully','Smokey Town','Smokeytown','Smoko','Smythes Creek','Smythesdale','Snake Island',
  'Snake Valley','Soldiers Hill','Somers','Somerton','Somerton Park','Somerville','Sorrento','South Dudley',
  'South Geelong','South Kingsville','South Kinypanial','South Melbourne','South Morang','South Purrumbete',
  'South Wharf','South Yarra','Southbank','Southern Cross','Southland Centre','Sovereign Hill','Spargo Creek',
  'Specimen Hill','Speed','Speewa','Spotswood','Spring Gully','Spring Hill','Springbank','Springdallah',
  'Springfield','Springhurst','Springmount','Springvale','Springvale South','St Albans','St Albans Park',
  'St Andrews Beach','St Arnaud','St Arnaud East','St Arnaud North','St Clair','St Germains','St Helena',
  'St Helens','St Helens Plains','St Helier','St James','St Kilda','St Kilda East','St Kilda Road Central',
  'St Kilda Road Melbourne','St Kilda South','St Kilda West','St Leonards','Staceys Bridge','Staffordshire Reef',
  'Staghorn Flat','Stanhope','Stanhope South','Stanley','Staughton Vale','Stavely','Stawell','Stawell West',
  'Steels Creek','Steiglitz','Stewarton','Stirling','Stockdale','Stockyard Hill','Stonehaven','Stoneleigh',
  'Stony Creek','Stonyford','Stradbroke','Stradbroke Park','Strangways','Straten','Stratford','Strath Creek',
  'Strathallan','Strathbogie','Strathdale','Strathdownie','Strathewen','Strathfieldsaye','Strathkellar','Strathlea',
  'Strathmerton','Strathmore','Strathmore Heights','Strathtulloh','Streatham','Strzelecki','Stuart Mill',
  'Studfield','Sugarloaf','Sugarloaf Creek','Suggan Buggan','Sulky','Summerfield','Summerlands','Sumner','Sunbury',
  'Sunday Creek','Sunderland Bay','Sunnycliffs','Sunset Strip','Sunshine','Sunshine North','Sunshine West',
  'Surf Beach','Surrey Hills','Surrey Hills North','Surrey Hills South','Sutherland','Sutherlands Creek','Sutton',
  'Sutton Grange','Swan Bay','Swan Hill','Swan Hill Pioneer','Swan Hill West','Swan Island','Swan Marsh',
  'Swan Reach','Swanpool','Swanwater','Swanwater West','Swifts Creek','Sydenham','Sylvaterre','Sylvester','Syndal',
  'Tabberabbera','Tabilk','Tabor','Taggerty','Tahara','Tahara Bridge','Tahara West','Talbot','Talgarno',
  'Tallandoon','Tallangatta','Tallangatta East','Tallangatta South','Tallangatta Valley','Tallarook',
  'Tallygaroopna','Tambo Crossing','Tambo Upper','Tamboon','Tamboritha','Taminick','Tamleugh','Tamleugh North',
  'Tamleugh West','Tandarook','Tandarra','Tangambalanga','Tanjil','Tanjil Bren','Tanjil South','Tankerton',
  'Tantaraboo','Tanwood','Tanybryn','Taradale','Tarago','Tarcombe','Tarilta','Taripta','Tarnagulla','Tarneit',
  'Tarnook','Taroon','Tarra Valley','Tarranyurk','Tarraville','Tarrawarra','Tarrawingee','Tarrayoukyan',
  'Tarrengower','Tarrenlea','Tarrington','Tarrone','Tarwin','Tarwin East','Tarwin Lower','Tatong','Tatura',
  'Tatura East','Tatyoon','Tawonga','Tawonga South','Taylor Bay','Taylors Hill','Taylors Lakes','Teal Point',
  'Tecoma','Teddywaddy','Teddywaddy West','Teesdale','Telangatuk East','Telford','Telopea Downs','Templestowe',
  'Templestowe Lower','Tempy','Tenby Point','Tennyson','Terang','Terip Terip','Terrappee','Terrick Terrick',
  'Terrick Terrick East','Tesbury','Tetoora Road','Thalia','Thalloo','Thaloo','The Basin','The Cove',
  'The Fingerboard','The Gurdies','The Heart','The Honeysuckles','The Patch','The Pines','The Settlement',
  'The Sisters','Thologolong','Thomastown','Thomson','Thoona','Thornbury','Thornhill Park','Thornton','Thorpdale',
  'Thorpdale South','Thowgla Valley','Three Bridges','Tidal River','Timbarra','Timboon','Timboon West','Timmering',
  'Timor','Timor West','Tinamba','Tinamba West','Tintaldra','Tittybong','Titybong','Tol Tol','Tolmie','Tom Groggin',
  'Tongala','Tonghi Creek','Tongio','Tonimbuk','Tooan','Tooborac','Toolamba','Toolamba West','Toolangi',
  'Toolern Vale','Toolleen','Toolome','Toolondo','Toolong','Toombon','Toongabbie','Toora','Toora North','Tooradin',
  'Toorak','Toorloo Arm','Tooronga','Toorongo','Tootgarook','Torquay','Torrita','Torrumbarry','Torwood','Tostaree',
  'Tottenham','Tottington','Tourello','Towan','Towaninny','Towaninny South','Tower Hill','Towong','Towong Upper',
  'Trafalgar','Trafalgar East','Trafalgar South','Tragowel','Traralgon','Traralgon East','Traralgon South',
  'Travancore','Trawalla','Trawool','Traynors Lagoon','Tremont','Trentham','Trentham East','Tresco','Tresco West',
  'Trida','Truganina','Tubbut','Tuerong','Tulkara','Tullamarine','Tungamah','Tunstall Square Po','Turoar','Turriff',
  'Turriff East','Turtons Creek','Tutye','Tyaak','Tyabb','Tyenna','Tyers','Tylden','Tylden South','Tynong',
  'Tynong North','Tyntynder','Tyntynder South','Tyrendarra','Tyrendarra East','Tyrrell','Tyrrell Downs',
  'Tysons Reef','Ullina','Ullswater','Ultima','Ultima East','Ulupna','Undera','Underbool','University Of Melbourne',
  'Uplands','Upotipotpon','Upper Ferntree Gully','Upper Gundowring','Upper Lurg','Upper Plenty','Upper Ryans Creek',
  'Upton Hill','Upwey','Valencia Creek','Vasey','Vaughan','Vectis','Ventnor','Venus Bay','Vermont','Vermont South',
  'Vervale','Vesper','Victoria Gardens','Victoria Point','Victoria Valley','Viewbank','Vinifera','Violet Town',
  'Vite Vite','Vite Vite North','W Tree','Waaia','Waanyarra','Waarre','Wabonga','Waggarandall','Wahgunyah',
  'Wahring','Wail','Wairewa','Waitchie','Wal Wal','Waldara','Walhalla','Walhalla East','Walkerville',
  'Walkerville North','Walkerville South','Wallace','Wallacedale','Wallagaraugh','Wallaloo','Wallaloo East',
  'Wallan','Wallan East','Wallinduc','Wallington','Wallup','Walmer','Walpa','Walpeup','Walwa','Wanalta',
  'Wandana Heights','Wandella','Wandiligong','Wandin East','Wandin North','Wando Bridge','Wando Vale','Wandong',
  'Wandown','Wangandary','Wangarabell','Wangaratta','Wangaratta Forward','Wangaratta South','Wangaratta West',
  'Wangie','Wangoom','Wannon','Wantirna','Wantirna South','Waranga','Waranga Shores','Waratah Bay','Waratah North',
  'Warburton','Wareek','Wargan','Warmur','Warncoort','Warne','Warneet','Warrabkook','Warracknabeal','Warragul',
  'Warragul South','Warragul West','Warrak','Warrandyte','Warrandyte South','Warranwood','Warrayure','Warrenbayne',
  'Warrenheip','Warrenmang','Warrion','Warrnambool','Warrnambool East','Warrnambool West','Warrock','Warrong',
  'Wartook','Watchem','Watchem West','Watchupga','Waterford','Waterford Park','Watergardens','Waterholes',
  'Waterloo','Waterways','Watgania','Watsonia','Watsonia North','Watsons Creek','Wattle Bank','Wattle Creek',
  'Wattle Flat','Wattle Glen','Wattle Hill','Wattle Park','Wattletree Road Po','Wattville','Waubra','Waurn Ponds',
  'Waverley Gardens','Waygara','Weatherboard','Wedderburn','Wedderburn Junction','Wee Wee Rup','Weeaproinah',
  'Weeragua','Weering','Weerite','Wehla','Weir Views','Wellsford','Welshmans Reef','Welshpool','Wemen','Wendouree',
  'Wendouree Village','Wensleydale','Wentworth','Were Street Po','Werneth','Werona','Werribee','Werribee South',
  'Werrimull','Wesburn','West Bendigo','West Creek','West Footscray','West Melbourne','West Wodonga','Westbury',
  'Westby','Westmeadows','Westmere','Whanregarwen','Wharparilla','Wheatsheaf','Wheelers Hill','Whipstick','Whirily',
  'White Hills','Whiteheads Creek','Whitelaw','Whitfield','Whitlands','Whittington','Whittlesea','Whoorel',
  'Whorouly','Whorouly East','Whorouly South','Whroo','Wickliffe','Wilby','Wild Dog Valley','Wildwood','Wilkur',
  'Willangie','Willatook','Willaura','Willaura North','Willenabrina','Williams Landing','Williams RAAF',
  'Williamstown','Williamstown North','Willow Grove','Willowmavin','Willowvale','Willung','Willung South',
  'Wilsons Hill','Wilsons Promontory','Wimbledon Heights','Winchelsea','Winchelsea South','Windermere','Windsor',
  'Wingan River','Wingeel','Winjallok','Winlaton','Winnambool','Winnap','Winnindoo','Winslow','Winter Valley',
  'Winton','Winton North','Wirrate','Wiseleigh','Wishart','Wodonga','Wodonga Forward','Wodonga Plaza','Wollert',
  'Wombat Creek','Wombelano','Won Wron','Wonga','Wonga Park','Wongarra','Wongungarra','Wonnangatta','Wonthaggi',
  'Wonwondah','Wonwondah East','Wonwondah South','Wonyip','Wood Wood','Woodbrook','Woodend','Woodend North',
  'Woodfield','Woodford','Woodglen','Woodhouse','Woodleigh','Woods Point','Woodside','Woodside Beach',
  'Woodside North','Woodstock','Woodstock On Loddon','Woodstock West','Woodvale','Woohlpooer','Wool Wool',
  'Woolamai','Woolenook','Woolshed','Woolshed Flat','Woolsthorpe','Woomelang','Wooragee','Woorarra','Woorarra East',
  'Woorarra West','Wooreen','Woori Yallock','Woorinen','Woorinen North','Woorinen South','Woorndoo','Wooroonook',
  'Woosang','Wootong Vale','World Trade Centre','Worrowing','Wrathung','Wrixon','Wroxham','Wuk Wuk','Wulgulmerang',
  'Wulgulmerang East','Wulgulmerang West','Wunghnu','Wurdiboluc','Wurruk','Wy Yung','Wycheproof','Wycheproof South',
  'Wychitella','Wychitella North','Wye River','Wyelangta','Wyndham Vale','Wyuna','Wyuna East','Yaapeet',
  'Yabba North','Yabba South','Yackandandah','Yalca','Yalla-Y-Poora','Yallambie','Yallook','Yallourn',
  'Yallourn North','Yalmy','Yambuk','Yambuna','Yan Yean','Yanac','Yanakie','Yando','Yandoit','Yandoit Hills',
  'Yangery','Yangoura','Yannathan','Yapeen','Yarck','Yarpturk','Yarra Glen','Yarra Junction','Yarraberb','Yarragon',
  'Yarragon South','Yarram','Yarrambat','Yarraville','Yarraville West','Yarrawalla','Yarrawonga','Yarrawonga South',
  'Yarrowee','Yarroweyah','Yarrunga','Yarto','Yatchaw','Yawong Hills','Yea','Yellingbo','Yelta','Yendon','Yeo',
  'Yeodene','Yering','Yeungroon','Yeungroon East','Yielima','Yinnar','Yinnar South','York Plains','Youanmite',
  'Youarang','Yulecart','Yundool','Yuroke','Yuulong','Zeerust','Zumsteins',
].map(name => ({ name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }));
// Sanity guard on a fetched boundary's bounding box. 12km comfortably covered every
// Melbourne-metro suburb; regional Victorian localities (now searchable too) run much
// bigger, so this is looser — it's only here to catch a genuinely wrong Nominatim match.
const MAX_SPAN_KM = 35;

// Everything the layer inspector can change lives here.
const cfg = {
  terrain:    { on: true,  color: '#ffffff', metal: 0.0,  rough: 1.0,  exag: 1.0, res: 96 },
  base:       {            color: '#ffffff', metal: 0.0,  rough: 1.0,  depth: 36 },
  backing:    { on: true,  title: 'suburb', customTitle: '', outline: 0, title3d: true, nodes: true },
  frame:      { on: true,  material: 'black', thickness: 10, height: 10 },
  backdrop:   { on: true,  style: 'brick' },
  buildings:  { on: true,  color: '#c9d4e4', metal: 0.1,  rough: 0.85, defH: 8, scale: 1, extra: 0, minH: 0, fit: 'terrain', nodes: true, nodeSize: 10 },
  majorRoads: { on: true,  color: '#2e3947', metal: 0.0,  rough: 1.0,  widthScale: 1, lift: 2.5 },
  minorRoads: { on: true,  color: '#2e3947', metal: 0.0,  rough: 1.0,  widthScale: 1, lift: 2.0 },
  paths:      { on: true,  color: '#c9d4e4', metal: 0.0,  rough: 1.0,  widthScale: 1, lift: 0.3 },
  green:      { on: true,  color: '#40653c', metal: 0.0,  rough: 1.0,  lift: 1.8 },
  water:      { on: true,  color: '#3d6fa8', metal: 0.25, rough: 0.35, lift: 1.6 },
};

// One material per layer, updated live by the inspector.
const MATS = {};
for (const key of Object.keys(cfg)) {
  if (!cfg[key].color) continue;   // layers without a colour (e.g. backing map) have no material
  MATS[key] = new THREE.MeshStandardMaterial({
    color: new THREE.Color(cfg[key].color),
    metalness: cfg[key].metal,
    roughness: cfg[key].rough,
    side: THREE.DoubleSide,
  });
}

// reverse lookup: material → layer key (used to name/colour 3MF objects by layer)
const MAT2KEY = new Map();
for (const key of Object.keys(MATS)) MAT2KEY.set(MATS[key], key);

// human-readable layer names for exported 3MF objects
const LAYER_LABELS = {
  buildings: 'Buildings', majorRoads: 'Major roads', minorRoads: 'Minor roads',
  paths: 'Paths & tracks', green: 'Green space', water: 'Water',
  terrain: 'Terrain', base: 'Base block',
};

// A3 base sheet layout (portrait, north up, mm). The 3D model prints at 200 mm on
// its widest side and sits centred in the lower two-thirds of the sheet. Declared
// early so nothing downstream can hit them before initialisation.
const A3_W = 297, A3_H = 420;
const MODEL_PRINT_MM = 200;             // model's widest side, printed
const MODEL_CX_MM = A3_W / 2;           // 148.5 — model centred horizontally
const MODEL_CY_MM = A3_H * 2 / 3;       // 280 — middle of the bottom two-thirds

// title font cache — declared early so the startup preload can't hit a TDZ
let _titleFont = null, _titleFontPromise = null;

const $ = (id) => document.getElementById(id);

/* ============================================================ request cache

   A 30-day client-side cache (Cache Storage API) for the heavy, repeat-friendly
   network resources: AWS terrain-elevation tiles, Overpass results and Nominatim
   lookups. Cuts repeat downloads on revisits and is a good citizen towards the
   free community servers. Cleared on demand from the sidebar. (The Carto 2D
   basemap is cached separately by MapLibre / the browser HTTP cache.)            */

const CACHE_NAME = 'mapforge-cache-v1';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;   // 30 days
const CACHE_OK = (typeof caches !== 'undefined');

async function cachedResponse(key, doFetch) {
  if (!CACHE_OK) return doFetch();
  let cache;
  try { cache = await caches.open(CACHE_NAME); } catch (e) { return doFetch(); }
  try {
    const hit = await cache.match(key);
    if (hit && Date.now() - Number(hit.headers.get('x-cached-at') || 0) < CACHE_TTL) return hit.clone();
  } catch (e) { /* fall through to network */ }
  const resp = await doFetch();
  try {
    if (resp && resp.ok) {
      const buf = await resp.clone().arrayBuffer();
      const h = new Headers();
      h.set('x-cached-at', String(Date.now()));
      const ct = resp.headers.get('Content-Type'); if (ct) h.set('Content-Type', ct);
      await cache.put(key, new Response(buf, { status: 200, headers: h }));
    }
  } catch (e) { /* over quota etc — ignore, still return the live response */ }
  return resp;
}
const cachedFetch = (url, opts) => cachedResponse(url, () => fetch(url, opts));

async function clearRequestCache() {
  if (!CACHE_OK) { setStatus('Caching isn’t available in this context.', true); return; }
  try { await caches.delete(CACHE_NAME); setStatus('Cached map data cleared.'); }
  catch (e) { setStatus('Could not clear the cache: ' + (e.message || e), true); }
}

/* ============================================================ 2D map */

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [145.0960, -37.8695],   // Queens Parade, Ashwood VIC
  zoom: 15,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

function metersPerPixel() {
  const lat = map.getCenter().lat;
  return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, map.getZoom());
}
function updateSelBox() {
  const el = $('selBox');
  // Never show the selection shape over the 3D viewer (a stray map 'move' or
  // window 'resize' event firing while the viewer's open would otherwise re-show it).
  if ($('viewer').style.display === 'block') { el.style.display = 'none'; return; }
  // Only show the shape in Custom mode once an area size has been chosen.
  if (state.uiMode !== 'custom' || !state.sizeMeters) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.classList.toggle('circle', state.areaShape === 'circle');
  const px = state.sizeMeters / metersPerPixel();
  const maxPx = Math.min(window.innerWidth, window.innerHeight) * 0.9;
  el.style.width = el.style.height = Math.min(px, maxPx) + 'px';
  const km = state.sizeMeters >= 1000 ? (state.sizeMeters / 1000) + ' km' : state.sizeMeters + ' m';
  $('selLabel').textContent = state.areaShape === 'circle' ? `${km} diameter` : `${km} × ${km}`;
}
map.on('move', updateSelBox);
map.on('load', updateSelBox);
window.addEventListener('resize', updateSelBox);

document.querySelectorAll('#shapeToggle button').forEach(btn => {
  btn.addEventListener('click', () => {
    state.areaShape = btn.dataset.shape;
    document.querySelectorAll('#shapeToggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updateSelBox();
  });
});

document.querySelectorAll('.size-grid button').forEach(btn => {
  btn.addEventListener('click', () => {
    // choosing an area size returns to square/circle mode (whichever shape's active)
    clearArea();
    document.querySelectorAll('.size-grid button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.sizeMeters = Number(btn.dataset.size);
    updateSelBox();
    updateLayersVisibility();
  });
});

/* ---------- suburb picker ---------- */

function drawAreaOutline(ll) {
  const fc = { type: 'FeatureCollection', features: ll.map(r => ({
    type: 'Feature', geometry: { type: 'LineString', coordinates: r } })) };
  if (map.getSource('area-bd')) { map.getSource('area-bd').setData(fc); return; }
  map.addSource('area-bd', { type: 'geojson', data: fc });
  map.addLayer({ id: 'area-bd', type: 'line', source: 'area-bd',
    paint: { 'line-color': '#4f8cff', 'line-width': 2.5, 'line-dasharray': [2, 1] } });
}
function clearAreaOutline() {
  if (map.getLayer('area-bd')) map.removeLayer('area-bd');
  if (map.getSource('area-bd')) map.removeSource('area-bd');
}
function clearArea() {
  state.mode = 'square';
  state.council = null;
  clearAreaOutline();
  updateSelBox();
  const inp = $('councilSearch'); if (inp) inp.value = '';
}

// Show the Layers + Generate controls only once there's something to build:
// a chosen suburb, or (in Custom mode) a chosen area size.
function updateLayersVisibility() {
  const ready = !!state.council || (state.uiMode === 'custom' && !!state.sizeMeters);
  $('layersSection').style.display = ready ? 'block' : 'none';
}

// Searchable suburb combobox: type to filter, click / arrow+Enter to choose.
function initSuburbPicker() {
  const input = $('councilSearch');
  const list = $('councilList');
  let current = [], active = -1;

  const render = () => {
    const f = input.value.trim().toLowerCase();
    current = f ? SUBURBS.filter(s => s.name.toLowerCase().includes(f)) : SUBURBS.slice();
    active = -1;
    list.innerHTML = '';
    if (!current.length) {
      const e = document.createElement('div'); e.className = 'combo-empty'; e.textContent = 'No matching suburb.';
      list.appendChild(e); return;
    }
    current.slice(0, 300).forEach((s) => {
      const o = document.createElement('div');
      o.className = 'combo-opt'; o.textContent = s.name;
      o.addEventListener('mousedown', ev => { ev.preventDefault(); pick(s); });
      list.appendChild(o);
    });
  };
  const openList = () => { render(); list.classList.add('open'); };
  const closeList = () => { list.classList.remove('open'); active = -1; };
  const setActive = (i) => {
    const opts = list.querySelectorAll('.combo-opt');
    if (!opts.length) return;
    active = (i + opts.length) % opts.length;
    opts.forEach(o => o.classList.remove('active'));
    opts[active].classList.add('active');
    opts[active].scrollIntoView({ block: 'nearest' });
  };
  function pick(suburb) { input.value = suburb.name; closeList(); loadSuburb(suburb); }

  input.addEventListener('focus', openList);
  input.addEventListener('input', openList);
  input.addEventListener('blur', () => setTimeout(closeList, 150));   // let a click land first
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!list.classList.contains('open')) openList(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && current[active]) pick(current[active]); else if (current.length === 1) pick(current[0]); }
    else if (e.key === 'Escape') { closeList(); input.blur(); }
  });
}
initSuburbPicker();

// Load a suburb's boundary and switch into suburb mode.
async function loadSuburb(suburb) {
  setStatus('');
  setLoading(true, `Finding the ${suburb.name} boundary…`);
  try {
    const b = await fetchSuburbBoundary(suburb.name);
    // sanity guard: reject an unexpectedly huge match
    const wkm = (b.bbox.east - b.bbox.west) * 111.32 * Math.cos(b.bbox.lat0 * Math.PI / 180);
    const hkm = (b.bbox.north - b.bbox.south) * 111.32;
    if (Math.max(wkm, hkm) > MAX_SPAN_KM) throw new Error(`matched area is too large (${Math.max(wkm, hkm).toFixed(1)} km across)`);
    state.council = { name: suburb.name, slug: suburb.slug, bbox: b.bbox, maskRings: b.maskRings, postcode: b.postcode };
    state.mode = 'suburb';
    state.modelName = suburb.slug;
    updateLayersVisibility();
    drawAreaOutline(b.ll);
    $('selBox').style.display = 'none';
    map.fitBounds([[b.bbox.west, b.bbox.south], [b.bbox.east, b.bbox.north]], { padding: 40, duration: 800 });
  } catch (e) {
    setStatus('Could not load that suburb boundary: ' + (e.message || e), true);
    clearArea();
    updateLayersVisibility();
  } finally {
    setLoading(false);
  }
}

/* ---------- mode toggle (Suburb / Custom) ---------- */

state.uiMode = 'suburb';
function setMode(mode) {
  state.uiMode = mode;
  const suburb = mode === 'suburb';
  $('suburbPanel').style.display = suburb ? 'block' : 'none';
  $('customPanel').style.display = suburb ? 'none' : 'block';
  $('modeSuburb').classList.toggle('active', suburb);
  $('modeCustom').classList.toggle('active', !suburb);
  if (suburb) {
    // Suburb mode: no square selection on the map.
    $('selBox').style.display = 'none';
    if (state.council) state.mode = 'suburb';
  } else {
    // Custom mode: reset to a square selection the user pans over the map.
    clearArea();          // → square mode, clears any suburb
    updateSelBox();
    // No suburb name to print in Custom mode, so default the backing title to Custom.
    cfg.backing.title = 'custom';
    const sel = document.getElementById('ctl_backing_title');
    if (sel) { sel.value = 'custom'; sel.dispatchEvent(new Event('change')); }
  }
  updateLayersVisibility();
}
$('modeSuburb').addEventListener('click', () => setMode('suburb'));
$('modeCustom').addEventListener('click', () => setMode('custom'));
setMode('suburb');        // default view

/* ============================================================ search */

async function doSearch() {
  const q = $('searchInput').value.trim();
  if (!q) return;
  const box = $('searchResults');
  box.innerHTML = '<div class="search-result">Searching…</div>';
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' + encodeURIComponent(q);
    const res = await cachedFetch(url, { headers: { 'Accept': 'application/json' } });
    const results = await res.json();
    box.innerHTML = '';
    if (!results.length) {
      box.innerHTML = '<div class="search-result">No results found.</div>';
      return;
    }
    for (const r of results) {
      const div = document.createElement('div');
      div.className = 'search-result';
      div.textContent = r.display_name;
      div.addEventListener('click', () => {
        map.flyTo({ center: [Number(r.lon), Number(r.lat)], zoom: 15 });
        state.modelName = (r.display_name.split(',')[0] || 'map')
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        box.innerHTML = '';
        showViewer(false);
      });
      box.appendChild(div);
    }
  } catch (e) {
    box.innerHTML = '<div class="search-result">Search failed — try again.</div>';
  }
}
$('searchBtn').addEventListener('click', doSearch);
$('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

/* ============================================================ geo helpers */

function makeProjector(lat0, lon0) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  return (lat, lon) => [ (lon - lon0) * mLon, (lat - lat0) * mLat ];
}

function currentBBox() {
  if (state.mode === 'suburb' && state.council) return state.council.bbox;
  const c = map.getCenter();
  const half = state.sizeMeters / 2;
  const dLat = half / 111320;
  const dLon = half / (111320 * Math.cos(c.lat * Math.PI / 180));
  return { south: c.lat - dLat, north: c.lat + dLat, west: c.lng - dLon, east: c.lng + dLon, lat0: c.lat, lon0: c.lng };
}

/* ============================================================ council mask */

// Even-odd point test over a set of rings (outer islands; holes flip parity).
function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// Clip a polyline to the inside of an arbitrary polygon mask (concave OK).
// Returns an array of runs (each ≥ 2 points) that lie within the mask.
function clipLineToMask(pts, rings) {
  const runs = [];
  let run = [];
  const push = () => { if (run.length > 1) runs.push(run); run = []; };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    // collect crossing parameters t along segment a→b against every mask edge
    const ts = [0, 1];
    for (const ring of rings) {
      for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
        const p = ring[m], q = ring[k];
        const d1x = b[0] - a[0], d1y = b[1] - a[1];
        const d2x = q[0] - p[0], d2y = q[1] - p[1];
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((p[0] - a[0]) * d2y - (p[1] - a[1]) * d2x) / den;
        const u = ((p[0] - a[0]) * d1y - (p[1] - a[1]) * d1x) / den;
        if (t > 1e-9 && t < 1 - 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
      }
    }
    ts.sort((m, n) => m - n);
    for (let s = 0; s < ts.length - 1; s++) {
      const t0 = ts[s], t1 = ts[s + 1];
      if (t1 - t0 < 1e-9) continue;
      const mt = (t0 + t1) / 2;
      const mx = a[0] + (b[0] - a[0]) * mt, my = a[1] + (b[1] - a[1]) * mt;
      const p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      if (pointInRings(mx, my, rings)) {
        if (run.length === 0) run.push(p0);
        else if (Math.hypot(run[run.length - 1][0] - p0[0], run[run.length - 1][1] - p0[1]) > 1e-6) { push(); run.push(p0); }
        run.push(p1);
      } else {
        push();
      }
    }
  }
  push();
  return runs;
}

// Fetch a suburb boundary polygon from Nominatim (returns the geometry directly,
// far more reliable than guessing OSM admin levels). Returns projected mask rings
// (local metres around the suburb centroid) + lon/lat rings + a bbox.
async function fetchSuburbBoundary(name) {
  // bounded to a Victoria-wide viewbox so same-named suburbs in other states don't match
  const url = 'https://nominatim.openstreetmap.org/search?format=json&polygon_geojson=1&addressdetails=1'
    + '&limit=8&viewbox=140.8,-39.3,150.1,-33.8&bounded=1&q='
    + encodeURIComponent(name + ', Victoria, Australia');
  const res = await cachedFetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('Nominatim HTTP ' + res.status);
  const results = await res.json();
  if (!results.length) throw new Error('suburb "' + name + '" not found');

  let outerLL;
  const cand = results.find(r => r.geojson && (r.geojson.type === 'Polygon' || r.geojson.type === 'MultiPolygon'));
  const postcode = (cand && cand.address && cand.address.postcode)
    || (results[0].address && results[0].address.postcode) || '';
  if (cand) {
    const gj = cand.geojson;
    const polygons = gj.type === 'Polygon' ? [gj.coordinates] : gj.coordinates;
    outerLL = polygons.map(p => p[0]); // outer ring of each polygon ([lon,lat] pairs)
  } else {
    // no boundary polygon in OSM — fall back to the result's bounding rectangle
    const bb = (results[0].boundingbox || []).map(Number); // [south, north, west, east]
    if (bb.length !== 4) throw new Error('no boundary found for "' + name + '"');
    const [s, n, w, e] = bb;
    outerLL = [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
  }

  let west = 180, east = -180, south = 90, north = -90;
  for (const r of outerLL) for (const [lon, lat] of r) {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  const lat0 = (south + north) / 2, lon0 = (west + east) / 2;
  const project = makeProjector(lat0, lon0);
  const maskRings = outerLL.map(r => r.map(([lon, lat]) => project(lat, lon)));
  return { bbox: { west, south, east, north, lat0, lon0 }, maskRings, ll: outerLL, postcode };
}

// Reverse-geocode the area centre to a suburb name + postcode for the backing-map
// title. Best-effort: in suburb mode we already have both, so skip the request.
async function ensurePlaceLabels(bbox) {
  if (state.council && state.council.name && state.council.postcode) {
    state.placeLabels = { suburb: state.council.name, postcode: state.council.postcode };
    return;
  }
  try {
    const url = 'https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&zoom=14'
      + '&lat=' + bbox.lat0 + '&lon=' + bbox.lon0;
    const res = await cachedFetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('reverse HTTP ' + res.status);
    const a = (await res.json()).address || {};
    state.placeLabels = {
      suburb: (state.council && state.council.name)
        || a.suburb || a.neighbourhood || a.city_district || a.town || a.village || a.city || '',
      postcode: (state.council && state.council.postcode) || a.postcode || '',
    };
  } catch (e) {
    console.warn('Place labels unavailable', e);
  }
}

/* ============================================================ boundary clipping */

// Clip a polygon ring to the square [-half, half]² (Sutherland–Hodgman).
function clipRingToSquare(ring, half) {
  let out = ring;
  for (const [axis, dir] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
    const inp = out;
    out = [];
    if (!inp.length) return [];
    const inside = p => p[axis] * dir >= -half;
    const bound = -half * dir; // p[axis] value on this clip edge
    for (let i = 0; i < inp.length; i++) {
      const prev = inp[(i + inp.length - 1) % inp.length];
      const cur = inp[i];
      const curIn = inside(cur), prevIn = inside(prev);
      if (curIn !== prevIn) {
        const t = (bound - prev[axis]) / (cur[axis] - prev[axis]);
        out.push([
          prev[0] + t * (cur[0] - prev[0]),
          prev[1] + t * (cur[1] - prev[1]),
        ]);
      }
      if (curIn) out.push(cur);
    }
  }
  return out.length >= 3 ? out : [];
}

// Clip a polyline to the square; returns an array of runs (each ≥ 2 points).
function clipLineToSquare(pts, half) {
  const runs = [];
  let run = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const dx = x2 - x1, dy = y2 - y1;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, x1 + half], [dx, half - x1], [-dy, y1 + half], [dy, half - y1]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else       { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { if (run.length > 1) runs.push(run); run = []; continue; }
    const a = [x1 + t0 * dx, y1 + t0 * dy];
    const b = [x1 + t1 * dx, y1 + t1 * dy];
    if (run.length === 0) run.push(a);
    else {
      const last = run[run.length - 1];
      if (Math.hypot(last[0] - a[0], last[1] - a[1]) > 1e-6) {
        if (run.length > 1) runs.push(run);
        run = [a];
      }
    }
    run.push(b);
    if (t1 < 1) { runs.push(run); run = []; }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/* ---------- generalized extent (rectangle + optional council mask) ---------- */

// The active build extent, set by buildModel(). Square mode: hx=hy=size/2,
// mask=null. Council mode: hx/hy from the council bbox, mask = its rings.
let EXT = { hx: 1000, hy: 1000, mask: null };

// Rectangle ring clip [-hx,hx]×[-hy,hy] (Sutherland–Hodgman, per-axis).
function clipRingToRect(ring, hx, hy) {
  let out = ring;
  for (const [axis, dir] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
    const h = axis === 0 ? hx : hy;
    const inp = out; out = [];
    if (!inp.length) return [];
    const inside = p => p[axis] * dir >= -h;
    const bound = -h * dir;
    for (let i = 0; i < inp.length; i++) {
      const prev = inp[(i + inp.length - 1) % inp.length];
      const cur = inp[i];
      const curIn = inside(cur), prevIn = inside(prev);
      if (curIn !== prevIn) {
        const t = (bound - prev[axis]) / (cur[axis] - prev[axis]);
        out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
      }
      if (curIn) out.push(cur);
    }
  }
  return out.length >= 3 ? out : [];
}

function clipLineToRect(pts, hx, hy) {
  const runs = [];
  let run = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const dx = x2 - x1, dy = y2 - y1;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, x1 + hx], [dx, hx - x1], [-dy, y1 + hy], [dy, hy - y1]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else       { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { if (run.length > 1) runs.push(run); run = []; continue; }
    const a = [x1 + t0 * dx, y1 + t0 * dy];
    const b = [x1 + t1 * dx, y1 + t1 * dy];
    if (run.length === 0) run.push(a);
    else {
      const last = run[run.length - 1];
      if (Math.hypot(last[0] - a[0], last[1] - a[1]) > 1e-6) { if (run.length > 1) runs.push(run); run = [a]; }
    }
    run.push(b);
    if (t1 < 1) { runs.push(run); run = []; }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

const clampX = v => Math.max(-EXT.hx, Math.min(EXT.hx, v));
const clampY = v => Math.max(-EXT.hy, Math.min(EXT.hy, v));
const insideExtent = (x, y) => Math.abs(x) <= EXT.hx && Math.abs(y) <= EXT.hy
  && (!EXT.mask || pointInRings(x, y, EXT.mask));

// Clip a polyline to the active extent (rectangle then, if present, the mask).
function clipLineToExtent(pts) {
  let runs = clipLineToRect(pts, EXT.hx, EXT.hy);
  if (!EXT.mask) return runs;
  const out = [];
  for (const r of runs) for (const rr of clipLineToMask(r, EXT.mask)) out.push(rr);
  return out;
}

/* ============================================================ Overpass */

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function fetchOSM(bbox) {
  const bb = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const parts = [
    `way["building"](${bb});`,
    `relation["building"]["type"="multipolygon"](${bb});`,
    `node["addr:housenumber"](${bb});`,
    `node["building"](${bb});`,
    `way["highway"](${bb});`,
    `way["natural"="water"](${bb});`,
    `relation["natural"="water"]["type"="multipolygon"](${bb});`,
    `way["waterway"="riverbank"](${bb});`,
    `way["waterway"~"^(river|stream|canal|drain)$"](${bb});`,
    `way["leisure"~"^(park|garden|pitch|golf_course)$"](${bb});`,
    `relation["leisure"~"^(park|garden|golf_course)$"]["type"="multipolygon"](${bb});`,
    `way["landuse"~"^(grass|meadow|forest|recreation_ground|village_green|cemetery)$"](${bb});`,
    `relation["landuse"~"^(grass|meadow|forest|recreation_ground|village_green|cemetery)$"]["type"="multipolygon"](${bb});`,
    `way["natural"~"^(wood|scrub|heath|grassland)$"](${bb});`,
    `relation["natural"~"^(wood|scrub|heath|grassland)$"]["type"="multipolygon"](${bb});`,
  ];
  const query = `[out:json][timeout:60];(${parts.join('')});out geom;`;

  // cache by the query (bbox-derived) so re-generating the same area is instant
  const key = 'https://mapforge.cache/overpass?v=1&q=' + encodeURIComponent(query);
  const res = await cachedResponse(key, async () => {
    let lastErr;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!r.ok) throw new Error('Overpass HTTP ' + r.status);
        return r;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Overpass unavailable');
  });
  return await res.json();
}

/* ============================================================ terrain */

const TERRAIN_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

function lonLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = (lon + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return [x, y];
}

async function buildElevationSampler(bbox) {
  let z = 14;
  while (z > 9) {
    const [x1] = lonLatToTile(bbox.west, bbox.lat0, z);
    const [x2] = lonLatToTile(bbox.east, bbox.lat0, z);
    if (x2 - x1 <= 3) break;
    z--;
  }
  const [txMinF, tyMinF] = lonLatToTile(bbox.west, bbox.north, z);
  const [txMaxF, tyMaxF] = lonLatToTile(bbox.east, bbox.south, z);
  const txMin = Math.floor(txMinF), tyMin = Math.floor(tyMinF);
  const txMax = Math.floor(txMaxF), tyMax = Math.floor(tyMaxF);

  const cols = txMax - txMin + 1, rows = tyMax - tyMin + 1;
  const T = 256;
  const canvas = document.createElement('canvas');
  canvas.width = cols * T; canvas.height = rows * T;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const jobs = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      jobs.push((async () => {
        // cached (30-day) fetch → bitmap, so repeat generations don't re-download tiles
        const resp = await cachedFetch(TERRAIN_URL(z, tx, ty));
        if (!resp || !resp.ok) throw new Error('elevation tile ' + z + '/' + tx + '/' + ty);
        const bmp = await createImageBitmap(await resp.blob());
        ctx.drawImage(bmp, (tx - txMin) * T, (ty - tyMin) * T);
        if (bmp.close) bmp.close();
      })());
    }
  }
  await Promise.all(jobs);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const W = canvas.width, H = canvas.height;

  const elevAt = (px, py) => {
    px = Math.max(0, Math.min(W - 1, px));
    py = Math.max(0, Math.min(H - 1, py));
    const i = (py * W + px) * 4;
    return (data[i] * 256 + data[i + 1] + data[i + 2] / 256) - 32768;
  };

  return (lat, lon) => {
    const [fx, fy] = lonLatToTile(lon, lat, z);
    const px = (fx - txMin) * T, py = (fy - tyMin) * T;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const dx = px - x0, dy = py - y0;
    return elevAt(x0, y0)     * (1 - dx) * (1 - dy)
         + elevAt(x0 + 1, y0) * dx * (1 - dy)
         + elevAt(x0, y0 + 1) * (1 - dx) * dy
         + elevAt(x0 + 1, y0 + 1) * dx * dy;
  };
}

/* ============================================================ geometry helpers */

function ringFromGeometry(geom, project) {
  return geom.map(pt => project(pt.lat, pt.lon));
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function shapeFromRings(outer, holes) {
  const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes || []) {
    shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  }
  return shape;
}

function taggedHeight(tags) {
  if (!tags) return null;
  const h = parseFloat(tags['height'] || tags['building:height']);
  if (!isNaN(h) && h > 0) return Math.min(h, 500);
  const lv = parseFloat(tags['building:levels']);
  if (!isNaN(lv) && lv > 0) return Math.min(lv * 3.2 + 1.5, 500);
  return null;
}

function centroidOf(ring) {
  let x = 0, y = 0;
  for (const [px, py] of ring) { x += px; y += py; }
  return [x / ring.length, y / ring.length];
}

// Stitch multipolygon member ways (often fragments of a ring) into closed rings.
function stitchRings(members) {
  const frags = members.map(m => (m.geometry || []).slice()).filter(g => g.length >= 2);
  const rings = [];
  const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
  while (frags.length) {
    let ring = frags.pop();
    let extended = true;
    while (!same(ring[0], ring[ring.length - 1]) && extended) {
      extended = false;
      for (let i = 0; i < frags.length; i++) {
        const f = frags[i];
        const end = ring[ring.length - 1], start = ring[0];
        if (same(f[0], end))                 { ring = ring.concat(f.slice(1)); }
        else if (same(f[f.length - 1], end)) { ring = ring.concat(f.slice(0, -1).reverse()); }
        else if (same(f[f.length - 1], start)) { ring = f.slice(0, -1).concat(ring); }
        else if (same(f[0], start))          { ring = f.slice(1).reverse().concat(ring); }
        else continue;
        frags.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (ring.length >= 4) {
      if (!same(ring[0], ring[ring.length - 1])) ring = ring.concat([ring[0]]);
      rings.push(ring);
    }
  }
  return rings;
}

function collectPolygons(elements, match) {
  const polys = [];
  for (const el of elements) {
    if (!match(el.tags || {})) continue;
    if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
      polys.push({ tags: el.tags, outer: el.geometry, holes: [] });
    } else if (el.type === 'relation' && el.members) {
      const outers = stitchRings(el.members.filter(m => m.role === 'outer'));
      const inners = stitchRings(el.members.filter(m => m.role === 'inner'));
      for (const o of outers) {
        const oxy = o.map(p => [p.lon, p.lat]);
        const holes = inners.filter(inn => pointInRing(inn[0].lon, inn[0].lat, oxy));
        polys.push({ tags: el.tags, outer: o, holes });
      }
    }
  }
  return polys;
}

// Insert interpolated points so long edges follow the terrain when draped.
function densifyRing(ring, maxLen) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    out.push([x1, y1]);
    const d = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.ceil(d / maxLen);
    for (let s = 1; s < steps; s++) out.push([x1 + (x2 - x1) * s / steps, y1 + (y2 - y1) * s / steps]);
  }
  return out;
}

// Subdivide a 2D triangulation until no edge exceeds maxLen, so draped
// surfaces gain interior vertices and follow the terrain instead of
// letting bumps poke through large triangles. Midpoints are shared via a
// cache so neighbouring triangles stay stitched together (no cracks).
function subdivideTriangulation(verts, tris, maxLen) {
  const max2 = maxLen * maxLen;
  for (let iter = 0; iter < 8; iter++) {
    const midCache = new Map();
    const newTris = [];
    let changed = false;
    const midpoint = (a, b) => {
      const k = a < b ? a + '_' + b : b + '_' + a;
      let m = midCache.get(k);
      if (m === undefined) {
        m = verts.length;
        verts.push([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2]);
        midCache.set(k, m);
      }
      return m;
    };
    const long = (a, b) => {
      const dx = verts[a][0] - verts[b][0], dy = verts[a][1] - verts[b][1];
      return dx * dx + dy * dy > max2;
    };
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const ab = long(a, b), bc = long(b, c), ca = long(c, a);
      const count = (ab ? 1 : 0) + (bc ? 1 : 0) + (ca ? 1 : 0);
      if (count === 0) { newTris.push(a, b, c); continue; }
      changed = true;
      if (count === 3) {
        const p = midpoint(a, b), q = midpoint(b, c), r = midpoint(c, a);
        newTris.push(a, p, r,  p, b, q,  r, q, c,  p, q, r);
      } else if (count === 2) {
        // rotate so the two long edges are ab and bc
        let A = a, B = b, C = c;
        if (!ab && bc && ca)      { A = b; B = c; C = a; }
        else if (ab && !bc && ca) { A = c; B = a; C = b; }
        const p = midpoint(A, B), q = midpoint(B, C);
        newTris.push(A, p, C,  p, B, q,  p, q, C);
      } else {
        // rotate so the long edge is ab
        let A = a, B = b, C = c;
        if (bc)      { A = b; B = c; C = a; }
        else if (ca) { A = c; B = a; C = b; }
        const p = midpoint(A, B);
        newTris.push(A, p, C,  p, B, C);
      }
    }
    tris = newTris;
    if (!changed) break;
  }
  return tris;
}

function densifyLine(pts, maxLen) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
    const d = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(d / maxLen));
    for (let s = 1; s <= steps; s++) out.push([x1 + (x2 - x1) * s / steps, y1 + (y2 - y1) * s / steps]);
  }
  return out;
}

// Project → clip to the square → normalise winding. Returns {outer, holes} or null.
// Normalise winding: outer ring positive area (CCW), holes negative (CW).
function normaliseRings(outer, holes) {
  if (ringArea(outer) < 0) outer = outer.slice().reverse();
  const hs = (holes || []).map(h => ringArea(h) > 0 ? h.slice().reverse() : h);
  return { outer, holes: hs };
}

// Intersect a subject polygon (outer + holes) with the suburb mask, so features
// straddling the boundary are split at the line rather than dropped. Returns an
// array of {outer, holes} pieces.
function clipPolyToMask(outer, holes) {
  const close = r => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) ? r.concat([r[0]]) : r;
  const subject = [close(outer), ...holes.map(close)];
  const maskMP = EXT.mask.map(r => [close(r)]);
  let result;
  try { result = polygonClipping.intersection(subject, maskMP); }
  catch (e) { return []; }
  const out = [];
  for (const p of (result || [])) {
    if (!p.length || p[0].length < 4) continue;
    const o = p[0].slice(0, -1);                       // drop closing duplicate
    if (o.length < 3) continue;
    const hs = p.slice(1).map(r => r.slice(0, -1)).filter(r => r.length >= 3);
    out.push(normaliseRings(o, hs));
  }
  return out;
}

// Returns an array of clipped {outer, holes} pieces (empty if nothing remains).
function clippedRings(poly, project) {
  let outer = clipRingToRect(ringFromGeometry(poly.outer, project), EXT.hx, EXT.hy);
  if (outer.length < 3 || Math.abs(ringArea(outer)) < 1) return [];
  const holes = [];
  for (const h of poly.holes || []) {
    const r = clipRingToRect(ringFromGeometry(h, project), EXT.hx, EXT.hy);
    if (r.length >= 3) holes.push(r);
  }
  if (!EXT.mask) return [normaliseRings(outer, holes)];

  // suburb mode: fast path for fully-inside/outside, split only the straddlers
  let inCount = 0;
  for (const [x, y] of outer) if (pointInRings(x, y, EXT.mask)) inCount++;
  if (inCount === outer.length) return [normaliseRings(outer, holes)];       // fully inside
  if (inCount === 0) {
    // fully outside unless the (small) mask sits within a large subject polygon
    const maskTouches = EXT.mask.some(r => r.some(([mx, my]) => pointInRing(mx, my, outer)));
    if (!maskTouches) return [];
  }
  return clipPolyToMask(outer, holes);
}

/* ---------- terrain block (closed solid: displaced top, skirt, bottom) */

// Build a WATERTIGHT closed solid from a 2D triangulation: a draped top surface,
// a matching bottom surface, and side walls on the boundary edges — all sharing
// one vertex set, so there are no unwelded seams or T-junctions (no open edges).
// topY/botY are functions (x, y) → height.
// Appends one closed solid (top + bottom + boundary walls) for a 2D triangulation
// into shared position/index arrays, offsetting indices by whatever's already there
// — lets several rings/footprints accumulate into one merged watertight mesh.
function appendClosedSolid(positions, indices, verts, tris, topY, botY) {
  const base = positions.length / 3;
  const n = verts.length;
  for (const [x, y] of verts) positions.push(x, topY(x, y), -y);   // base .. base+n-1     top
  for (const [x, y] of verts) positions.push(x, botY(x, y), -y);   // base+n .. base+2n-1  bottom
  for (let t = 0; t < tris.length; t += 3) indices.push(base + tris[t], base + tris[t + 1], base + tris[t + 2]);
  for (let t = 0; t < tris.length; t += 3) indices.push(base + n + tris[t + 2], base + n + tris[t + 1], base + n + tris[t]);
  // side walls on the boundary edges (edges used by exactly one triangle) — this
  // closes the shape regardless of how messy the input triangulation is, since a
  // wall goes up wherever a triangle edge has no neighbour.
  const cnt = new Map(), dir = new Map();
  const key = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
  for (let t = 0; t < tris.length; t += 3) {
    const tri = [tris[t], tris[t + 1], tris[t + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3], k = key(a, b);
      cnt.set(k, (cnt.get(k) || 0) + 1);
      if (!dir.has(k)) dir.set(k, [a, b]);
    }
  }
  for (const [k, c] of cnt) {
    if (c !== 1) continue;
    const [a, b] = dir.get(k);
    indices.push(base + a, base + b, base + n + a,  base + b, base + n + b, base + n + a);
  }
}

function closedDrapedSolid(verts, tris, topY, botY) {
  const positions = [], indices = [];
  appendClosedSolid(positions, indices, verts, tris, topY, botY);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// How thick the terrain's own colour layer is (it's a thin watertight skin
// oversunk into the full-depth base block below, so both stay independently
// manifold — see closedDrapedSolid).
const TERRAIN_SKIN = 2;

function buildTerrainBlock(groundAt) {
  if (EXT.mask) return buildCouncilTerrain(groundAt);

  const hx = EXT.hx, hy = EXT.hy;
  const N = Math.max(16, Math.round(cfg.terrain.res / 16) * 16);
  const stepX = (2 * hx) / N, stepY = (2 * hy) / N;

  const verts = [];
  const V = (i, j) => j * (N + 1) + i;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) verts.push([-hx + i * stepX, -hy + j * stepY]);
  }
  const tris = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = V(i, j), b = V(i + 1, j), c = V(i + 1, j + 1), d = V(i, j + 1);
      tris.push(a, b, c, a, c, d);
    }
  }

  const bot = -Math.max(0.5, cfg.base.depth);
  const groundY = (x, y) => groundAt(x, y);

  const top = new THREE.Mesh(
    closedDrapedSolid(verts, tris, groundY, (x, y) => groundAt(x, y) - TERRAIN_SKIN),
    MATS.terrain);
  top.name = 'terrain';

  const skirt = new THREE.Mesh(
    closedDrapedSolid(verts, tris, groundY, () => bot),
    MATS.base);
  skirt.name = 'base';

  const g = new THREE.Group();
  g.add(top, skirt);
  return g;
}

// A closed, CCW circle ring (matches suburb maskRings' winding/format) centred
// on the origin — lets Custom-mode "Circle" reuse the whole suburb-mask
// pipeline (terrain shaping, building/road/water clipping) with no other code.
function circleRing(radius, segments) {
  const ring = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    ring.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return ring;
}

// Offset a closed ring outward by d metres (average-of-adjacent-edge normals).
// Keeps the terrain slightly larger than the clipped features so road ribbons
// that hug the boundary always land on the base rather than floating.
function bufferRingOutward(ring, d) {
  let r = ring.slice();
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
  const m = r.length;
  if (m < 3) return ring;
  const ccw = ringArea(r) > 0;               // outward normal side depends on winding
  const out = [];
  for (let i = 0; i < m; i++) {
    const p = r[(i + m - 1) % m], c = r[i], n = r[(i + 1) % m];
    const nrm = (ax, ay, bx, by) => { let dx = bx - ax, dy = by - ay; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l; return ccw ? [dy, -dx] : [-dy, dx]; };
    const n1 = nrm(p[0], p[1], c[0], c[1]), n2 = nrm(c[0], c[1], n[0], n[1]);
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) { out.push([c[0] + n1[0] * d, c[1] + n1[1] * d]); continue; }
    mx /= ml; my /= ml;
    const cosA = Math.max(0.3, mx * n1[0] + my * n1[1]); // miter length d/cos, clamped at sharp corners
    out.push([c[0] + mx * d / cosA, c[1] + my * d / cosA]);
  }
  out.push(out[0].slice());
  return out;
}

// Terrain shaped to the council boundary: a thin terrain-coloured skin over a
// full-depth base block, one closed solid each (see closedDrapedSolid), per mask ring.
function buildCouncilTerrain(groundAt) {
  const bot = -Math.max(0.5, cfg.base.depth);
  const group = new THREE.Group();
  const topPos = [], topIdx = [];    // thin draped skin (terrain material)
  const basePos = [], baseIdx = [];  // full-depth block (base material)
  for (const ringXY of EXT.mask) {
    let ring = bufferRingOutward(ringXY, 12); // ~ widest road half-width, so roads sit on the base
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring = ring.slice(0, -1);
    if (ring.length < 3) continue;
    const dense = densifyRing(ring, 40);
    // triangulate + subdivide the interior so bumps inside the council show
    const shapeGeo = new THREE.ShapeGeometry(new THREE.Shape(dense.map(([x, y]) => new THREE.Vector2(x, y))));
    const pos = shapeGeo.getAttribute('position');
    const rawIdx = shapeGeo.getIndex() ? shapeGeo.getIndex().array : null;
    if (!rawIdx) continue;
    const verts = [];
    for (let i = 0; i < pos.count; i++) verts.push([pos.getX(i), pos.getY(i)]);
    const tris = subdivideTriangulation(verts, Array.from(rawIdx), 60);
    const groundY = (x, y) => groundAt(x, y);
    appendClosedSolid(topPos, topIdx, verts, tris, groundY, (x, y) => groundAt(x, y) - TERRAIN_SKIN);
    appendClosedSolid(basePos, baseIdx, verts, tris, groundY, () => bot);
  }
  const topGeo = new THREE.BufferGeometry();
  topGeo.setAttribute('position', new THREE.Float32BufferAttribute(topPos, 3));
  topGeo.setIndex(topIdx); topGeo.computeVertexNormals();
  const top = new THREE.Mesh(topGeo, MATS.terrain); top.name = 'terrain';
  const baseGeo = new THREE.BufferGeometry();
  baseGeo.setAttribute('position', new THREE.Float32BufferAttribute(basePos, 3));
  baseGeo.setIndex(baseIdx); baseGeo.computeVertexNormals();
  const walls = new THREE.Mesh(baseGeo, MATS.base); walls.name = 'base';
  group.add(top, walls);
  return group;
}

/* ---------- buildings */

// Ray-casting point-in-polygon test.
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function buildBuildings(elements, project, groundAt, extraPolys) {
  const c = cfg.buildings;
  const group = new THREE.Group();
  group.name = 'buildings';
  const footprints = []; // unclipped projected outer rings, used to detect mapped buildings
  const polys = collectPolygons(elements, t => t['building'] !== undefined);
  if (extraPolys && extraPolys.length) polys.push(...extraPolys);
  // Merge every mapped building into one watertight mesh (see closedDrapedSolid):
  // each footprint's own top/bottom/wall triangles form an independent closed
  // shell, so real-world OSM footprints (touching holes, sliver clips, etc.)
  // can't leave open edges the way ExtrudeGeometry's cap triangulation could.
  const bldPos = [], bldIdx = [];
  for (const poly of polys) {
    try {
      footprints.push(ringFromGeometry(poly.outer, project));
      let h = taggedHeight(poly.tags);
      h = (h === null ? c.defH : h) * c.scale + c.extra;
      h = Math.max(h, c.minH, 1);
      for (const rings of clippedRings(poly, project)) {   // may be split at the boundary
        // ground reference + how far the base must sink to sit into the terrain everywhere
        let minG = Infinity;
        for (const [x, y] of rings.outer) minG = Math.min(minG, groundAt(x, y));
        let ground;
        if (c.fit === 'flat') {
          ground = minG;
        } else {
          const [cx, cy] = centroidOf(rings.outer);
          ground = groundAt(cx, cy);
        }
        const sink = Math.max(1.5, ground - minG + 0.5);
        const shapeGeo = new THREE.ShapeGeometry(shapeFromRings(rings.outer, rings.holes));
        const pos = shapeGeo.getAttribute('position');
        const rawIdx = shapeGeo.getIndex() ? shapeGeo.getIndex().array : null;
        if (!rawIdx) continue;
        const verts = [];
        for (let i = 0; i < pos.count; i++) verts.push([pos.getX(i), pos.getY(i)]);
        const top = ground + h, bot = ground - sink;
        appendClosedSolid(bldPos, bldIdx, verts, Array.from(rawIdx), () => top, () => bot);
      }
    } catch (e) { /* skip malformed footprints */ }
  }

  // Unmapped buildings: place a default box at OSM address / building nodes
  // that have no building outline (way) drawn yet.
  if (c.nodes) {
    const seen = new Set();
    const cell = Math.max(2, c.nodeSize * 0.8);
    for (const el of elements) {
      if (el.type !== 'node' || !el.tags) continue;
      if (el.tags['addr:housenumber'] === undefined && el.tags['building'] === undefined) continue;
      if (el.lat === undefined || el.lon === undefined) continue;
      const [x, y] = project(el.lat, el.lon);
      if (!insideExtent(x, y)) continue;
      // skip nodes that fall inside an already-mapped building footprint
      let covered = false;
      for (const ring of footprints) {
        if (pointInRing(x, y, ring)) { covered = true; break; }
      }
      if (covered) continue;
      // dedupe clusters of address nodes (e.g. multiple units on one lot)
      const key = Math.round(x / cell) + ':' + Math.round(y / cell);
      if (seen.has(key)) continue;
      seen.add(key);
      let h = taggedHeight(el.tags);
      h = (h === null ? c.defH : h) * c.scale + c.extra;
      h = Math.max(h, c.minH, 1);
      const s = c.nodeSize;
      // keep the box fully inside the extent
      const bx = Math.max(-EXT.hx + s / 2, Math.min(EXT.hx - s / 2, x));
      const by = Math.max(-EXT.hy + s / 2, Math.min(EXT.hy - s / 2, y));
      const ground = groundAt(bx, by);
      let minG = ground;
      for (const [ox, oy] of [[-s / 2, -s / 2], [s / 2, -s / 2], [-s / 2, s / 2], [s / 2, s / 2]]) {
        minG = Math.min(minG, groundAt(bx + ox, by + oy));
      }
      const sink = Math.max(1.0, ground - minG + 0.5);
      // built the same watertight way as mapped buildings (not THREE.BoxGeometry,
      // which duplicates a vertex per face for flat shading — fine to look at, but
      // not index-shared, so a strict 3MF checker like Bambu's flags it as open edges)
      const hs = s / 2;
      const verts = [[bx - hs, by - hs], [bx + hs, by - hs], [bx + hs, by + hs], [bx - hs, by + hs]];
      appendClosedSolid(bldPos, bldIdx, verts, [0, 1, 2, 0, 2, 3], () => ground + h, () => ground - sink);
    }
  }
  if (bldPos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bldPos, 3));
    geo.setIndex(bldIdx);
    geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, MATS.buildings));
  }
  return group;
}

/* ---------- roads (flat ribbons draped on terrain, split by class) */

const ROAD_WIDTHS = {
  motorway: 18, motorway_link: 10, trunk: 16, trunk_link: 9,
  primary: 13, primary_link: 8, secondary: 11, secondary_link: 7, tertiary: 9,
  unclassified: 7, residential: 7, living_street: 6, service: 4.5,
  pedestrian: 5, track: 3.5, cycleway: 2.5, footway: 2, path: 1.8, steps: 2,
};
const MAJOR = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link']);
const PATHS = new Set(['footway', 'path', 'cycleway', 'steps', 'track', 'pedestrian']);

function roadClass(kind) {
  if (MAJOR.has(kind)) return 'majorRoads';
  if (PATHS.has(kind)) return 'paths';
  return 'minorRoads';
}

function buildRoadClass(elements, project, groundAt, layerKey) {
  const c = cfg[layerKey];
  const group = new THREE.Group();
  group.name = layerKey;
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.tags.highway || !el.geometry) continue;
    if (el.tags.area === 'yes') continue;
    const kind = el.tags.highway;
    if (roadClass(kind) !== layerKey) continue;
    const width = (ROAD_WIDTHS[kind] || 5) * c.widthScale;
    const runs = clipLineToExtent(ringFromGeometry(el.geometry, project));
    const EMBED = 1.0; // how far the ribbon's underside sinks into the terrain
    for (const rawPts of runs) {
      if (rawPts.length < 2) continue;
      const pts = densifyLine(rawPts, 12); // follow the terrain closely
      const positions = [], indices = [];
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = pts[i];
        const [xp, yp] = pts[Math.max(0, i - 1)];
        const [xn, yn] = pts[Math.min(pts.length - 1, i + 1)];
        let dx = xn - xp, dy = yn - yp;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const nx = -dy, ny = dx;
        const lx = clampX(x + nx * width / 2), ly = clampY(y + ny * width / 2);
        const rx = clampX(x - nx * width / 2), ry = clampY(y - ny * width / 2);
        const gl = groundAt(lx, ly), gr = groundAt(rx, ry);
        // 4 vertices per cross-section: top-left, top-right, bottom-left, bottom-right
        positions.push(lx, gl + c.lift, -ly);
        positions.push(rx, gr + c.lift, -ry);
        positions.push(lx, gl - EMBED, -ly);
        positions.push(rx, gr - EMBED, -ry);
        if (i > 0) {
          const p = (i - 1) * 4, s = i * 4;
          indices.push(p, p + 1, s,  p + 1, s + 1, s);         // top
          indices.push(p + 2, s + 2, p + 3,  p + 3, s + 2, s + 3); // bottom
          indices.push(p, s, p + 2,  s, s + 2, p + 2);         // left wall
          indices.push(p + 1, p + 3, s + 1,  s + 1, p + 3, s + 3); // right wall
        }
      }
      // end caps
      const last = (pts.length - 1) * 4;
      indices.push(0, 2, 1,  1, 2, 3);
      indices.push(last, last + 1, last + 2,  last + 1, last + 3, last + 2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, MATS[layerKey]));
    }
  }
  return group;
}

/* ---------- flat polygon layers (water, green space) */

const GREEN_MATCH = t =>
  /^(park|garden|pitch|golf_course)$/.test(t['leisure'] || '') ||
  /^(grass|meadow|forest|recreation_ground|village_green|cemetery)$/.test(t['landuse'] || '') ||
  /^(wood|scrub|heath|grassland)$/.test(t['natural'] || '');

const WATER_MATCH = t => t['natural'] === 'water' || t['waterway'] === 'riverbank';

// Linear waterways (rivers, streams, canals, drains) are mapped as lines, not
// polygons — render them as draped ribbons like roads, into the water group.
const WATERWAY_WIDTHS = { river: 12, canal: 8, stream: 3.5, drain: 2.5 };

function addWaterwayLines(group, elements, project, groundAt) {
  const c = cfg.water;
  const EMBED = 1.0;
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.geometry) continue;
    const w = el.tags.waterway;
    if (!WATERWAY_WIDTHS[w]) continue;
    if (el.tags.tunnel === 'yes' || el.tags.tunnel === 'culvert') continue;
    const width = WATERWAY_WIDTHS[w];
    const runs = clipLineToExtent(ringFromGeometry(el.geometry, project));
    for (const rawPts of runs) {
      if (rawPts.length < 2) continue;
      const pts = densifyLine(rawPts, 12);
      const positions = [], indices = [];
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = pts[i];
        const [xp, yp] = pts[Math.max(0, i - 1)];
        const [xn, yn] = pts[Math.min(pts.length - 1, i + 1)];
        let dx = xn - xp, dy = yn - yp;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const nx = -dy, ny = dx;
        const lx = clampX(x + nx * width / 2), ly = clampY(y + ny * width / 2);
        const rx = clampX(x - nx * width / 2), ry = clampY(y - ny * width / 2);
        const gl = groundAt(lx, ly), gr = groundAt(rx, ry);
        positions.push(lx, gl + c.lift, -ly);
        positions.push(rx, gr + c.lift, -ry);
        positions.push(lx, gl - EMBED, -ly);
        positions.push(rx, gr - EMBED, -ry);
        if (i > 0) {
          const p = (i - 1) * 4, s = i * 4;
          indices.push(p, p + 1, s,  p + 1, s + 1, s);
          indices.push(p + 2, s + 2, p + 3,  p + 3, s + 2, s + 3);
          indices.push(p, s, p + 2,  s, s + 2, p + 2);
          indices.push(p + 1, p + 3, s + 1,  s + 1, p + 3, s + 3);
        }
      }
      const last = (pts.length - 1) * 4;
      indices.push(0, 2, 1,  1, 2, 3);
      indices.push(last, last + 1, last + 2,  last + 1, last + 3, last + 2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, MATS.water));
    }
  }
}

function buildFlatPolys(elements, project, groundAt, layerKey, match) {
  const c = cfg[layerKey];
  const DEPTH = 1.5; // how far the slab's underside sinks into the terrain
  const group = new THREE.Group();
  group.name = layerKey;
  const polys = collectPolygons(elements, match);
  for (const poly of polys) {
   for (const rings of clippedRings(poly, project)) {   // may be split at the boundary
    try {
      const outer = densifyRing(rings.outer, 15);
      const holes = rings.holes.map(h => densifyRing(h, 15));

      // triangulate in 2D, subdivide the interior, then drape every vertex
      const shapeGeo = new THREE.ShapeGeometry(shapeFromRings(outer, holes));
      const pos = shapeGeo.getAttribute('position');
      const rawIdx = shapeGeo.getIndex() ? shapeGeo.getIndex().array : null;
      if (!rawIdx) continue;
      const verts = [];
      for (let i = 0; i < pos.count; i++) verts.push([pos.getX(i), pos.getY(i)]);
      const tris = subdivideTriangulation(verts, Array.from(rawIdx), 15);
      // one watertight draped slab (top + underside + boundary walls, shared verts)
      const geo = closedDrapedSolid(verts, tris,
        (x, y) => groundAt(x, y) + c.lift, (x, y) => groundAt(x, y) - DEPTH);
      group.add(new THREE.Mesh(geo, MATS[layerKey]));
    } catch (e) { /* skip */ }
   }
  }
  return group;
}

/* ============================================================ model build (from cached data) */

function buildModel() {
  const { bbox, elements, sampleElev, minElev, prebaked } = state.last;
  const project = makeProjector(bbox.lat0, bbox.lon0);

  // set the active build extent: council mask if present, else the square
  if (state.mode === 'suburb' && state.council && state.council.maskRings) {
    const c = state.council;
    let hx = 0, hy = 0;
    for (const r of c.maskRings) for (const [x, y] of r) { hx = Math.max(hx, Math.abs(x)); hy = Math.max(hy, Math.abs(y)); }
    EXT = { hx: hx + 5, hy: hy + 5, mask: c.maskRings };
  } else if (state.uiMode === 'custom' && state.areaShape === 'circle') {
    const r = state.sizeMeters / 2;
    EXT = { hx: r, hy: r, mask: [circleRing(r, 96)] };
  } else {
    const half = state.sizeMeters / 2;
    EXT = { hx: half, hy: half, mask: null };
  }

  // ground height in relative metres at local x/y, with exaggeration applied
  const groundAt = (x, y) => {
    if (!cfg.terrain.on || !sampleElev) return 0;
    const lat = bbox.lat0 + y / 111320;
    const lon = bbox.lon0 + x / (111320 * Math.cos(bbox.lat0 * Math.PI / 180));
    return Math.max(0, (sampleElev(lat, lon) - minElev)) * cfg.terrain.exag;
  };

  const model = new THREE.Group();
  model.name = 'mapforge-model';
  model.add(buildTerrainBlock(groundAt));

  const counts = {};
  if (cfg.buildings.on) {
    const extra = prebaked ? prebakedToPolys(prebaked, project) : null;
    const g = buildBuildings(elements, project, groundAt, extra);
    counts.buildings = g.children.length;
    model.add(g);
  }
  for (const rk of ['majorRoads', 'minorRoads', 'paths']) {
    if (!cfg[rk].on) continue;
    const g = buildRoadClass(elements, project, groundAt, rk);
    counts[rk] = g.children.length;
    model.add(g);
  }
  if (cfg.green.on) {
    const g = buildFlatPolys(elements, project, groundAt, 'green', GREEN_MATCH);
    counts.green = g.children.length;
    model.add(g);
  }
  if (cfg.water.on) {
    const g = buildFlatPolys(elements, project, groundAt, 'water', WATER_MATCH);
    addWaterwayLines(g, elements, project, groundAt);
    counts.water = g.children.length;
    model.add(g);
  }
  return { model, counts };
}

// Convert a pre-baked buildings FeatureCollection into the poly shape the
// building builder consumes ({tags:{height}, outer:[{lat,lon}], holes:[...]}).
function prebakedToPolys(fc, project) {
  const polys = [];
  const toRing = coords => coords.map(([lon, lat]) => ({ lat, lon }));
  for (const ft of (fc.features || [])) {
    const g = ft.geometry; if (!g) continue;
    const h = ft.properties && ft.properties.h;
    const tags = (h != null) ? { height: String(h) } : {};
    const push = rings => {
      if (!rings || !rings.length || rings[0].length < 4) return;
      polys.push({ tags, outer: toRing(rings[0]), holes: rings.slice(1).map(toRing) });
    };
    if (g.type === 'Polygon') push(g.coordinates);
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) push(poly);
  }
  return polys;
}

// Load buildings/<slug>.buildings.json (returns null if none exists).
async function loadPrebaked(slug) {
  if (!slug) return null;
  try {
    const res = await fetch('buildings/' + slug + '.buildings.json', { cache: 'force-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

function swapModel() {
  if (!state.last) return null;
  const { model, counts } = buildModel();
  initViewer();
  if (state.model) {
    scene.remove(state.model);
    state.model.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
  state.model = model;
  scene.add(model);
  return counts;
}

// Debounced rebuild used by the layer inspector's geometry controls.
let rebuildTimer = null;
function scheduleRebuild() {
  if (!state.last) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    const counts = swapModel();
    if (counts) setStatus(statusLine(counts));
  }, 250);
}

// Route a layer control change to the right rebuild. The backing map is not part
// of the exported 3D model, so it rebuilds independently of the model geometry.
function layerChanged(key) {
  if (key === 'backing') { rebuildBaseLayer(); rebuildTitle3D(); }
  else if (key === 'frame') rebuildFrame();
  else if (key === 'backdrop') rebuildBackdrop();
  else scheduleRebuild();
}

// A geometry-value change; the base depth also shifts the base sheet, frame,
// backdrop and 3D title, so rebuild those too.
function geomChanged(ck) {
  scheduleRebuild();
  if (ck === 'base') { rebuildBaseLayer(); rebuildFrame(); rebuildBackdrop(); rebuildTitle3D(); }
}

function statusLine(counts) {
  const roads = (counts.majorRoads || 0) + (counts.minorRoads || 0) + (counts.paths || 0);
  return `Done — ${counts.buildings || 0} buildings, ${roads} road segments, ${counts.water || 0} water, ${counts.green || 0} green areas.`;
}

/* ============================================================ 3D viewer */

let renderer, scene, camera, controls;

function initViewer() {
  if (renderer) return;
  const el = $('viewer');
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(el.clientWidth, el.clientHeight);
  el.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  scene.fog = new THREE.Fog(0x0d1117, 2500, 6000);

  camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 1, 60000);

  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30363d, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(600, 900, 400);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
  fill.position.set(-500, 300, -600);
  scene.add(fill);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2.05;

  window.addEventListener('resize', resizeViewer);
  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();
}

function resizeViewer() {
  if (!renderer) return;
  const el = $('viewer');
  if (!el.clientWidth) return;
  camera.aspect = el.clientWidth / el.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(el.clientWidth, el.clientHeight);
}

function showViewer(on) {
  $('viewer').style.display = on ? 'block' : 'none';
  $('map').style.display = on ? 'none' : 'block';
  $('backBtn').style.display = on ? 'block' : 'none';
  $('dlMenu').style.display = on ? 'block' : 'none';
  if (on) updateDownloadMenu();
  if (on) { $('selBox').style.display = 'none'; resizeViewer(); }
  else { updateSelBox(); map.resize(); }
}
$('backBtn').addEventListener('click', () => showViewer(false));

/* ============================================================ generate */

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
}
function setLoading(on, text) {
  $('loading').style.display = on ? 'flex' : 'none';
  if (text) $('loadingText').textContent = text;
}

async function generate() {
  if (state.uiMode === 'suburb' && !state.council) {
    setStatus('Choose a suburb from the dropdown first — or switch to Custom mode to build a square area.', true);
    return;
  }
  if (state.uiMode === 'custom' && !state.sizeMeters) {
    setStatus('Choose an area size first.', true);
    return;
  }
  const bbox = currentBBox();
  $('generateBtn').disabled = true;
  setStatus('');
  setLoading(true, 'Fetching OpenStreetMap data…');

  try {
    const osmPromise = fetchOSM(bbox);
    let sampleElev = null;
    if (cfg.terrain.on) {
      setLoading(true, 'Fetching OpenStreetMap data + elevation tiles…');
      try {
        sampleElev = await buildElevationSampler(bbox);
      } catch (e) {
        console.warn('Elevation unavailable, using flat terrain', e);
      }
    }
    // pre-baked real footprints for the selected council (if a file exists)
    const prebaked = await loadPrebaked(state.council && state.council.slug);

    const osm = await osmPromise;
    const elements = osm.elements || [];

    setLoading(true, 'Building 3D geometry…');
    await new Promise(r => setTimeout(r, 30));

    let minElev = 0, maxElev = 0;
    if (sampleElev) {
      minElev = Infinity; maxElev = -Infinity;
      for (let j = 0; j <= 16; j++) {
        for (let i = 0; i <= 16; i++) {
          const lat = bbox.south + (bbox.north - bbox.south) * j / 16;
          const lon = bbox.west + (bbox.east - bbox.west) * i / 16;
          const e = sampleElev(lat, lon);
          minElev = Math.min(minElev, e);
          maxElev = Math.max(maxElev, e);
        }
      }
    }
    // highest terrain elevation of the map (relative metres, exaggeration applied)
    state.maxGround = sampleElev ? Math.max(0, (maxElev - minElev)) * cfg.terrain.exag : 0;

    state.last = { bbox, elements, sampleElev, minElev, prebaked };
    const counts = swapModel();

    // greyscale base sheet the model sits on (preview only; not in 3D exports).
    // The A3 sheet extends well beyond the built 3D area, so fetch a wider slice
    // of OSM context for it — best-effort; fall back to the model data on failure.
    const M = Math.max(2 * EXT.hx, 2 * EXT.hy);   // model's widest side in metres
    let baseElements = elements;
    try {
      const baseBbox = a3BaseBbox(bbox, M);
      setLoading(true, 'Fetching surrounding map for the base sheet…');
      const wider = await Promise.race([
        fetchOSM(baseBbox),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 45000)),
      ]);
      if (wider && wider.elements && wider.elements.length) baseElements = wider.elements;
    } catch (e) {
      console.warn('Wider base-sheet context unavailable, using model data', e);
    }
    // place labels (suburb + postcode) for the backing-map title — best-effort
    await ensurePlaceLabels(bbox);
    state.baseData = { bbox, elements: baseElements, prebaked, M };
    rebuildBaseLayer();
    rebuildFrame();
    rebuildBackdrop();
    rebuildTitle3D();

    const d = (state.mode === 'suburb' && state.council) ? 2 * Math.max(EXT.hx, EXT.hy) : state.sizeMeters;
    camera.position.set(d * 0.9, d * 0.95, d * 0.9);
    controls.target.set(0, 0, 0);
    controls.update();
    scene.fog.near = d * 6;
    scene.fog.far = d * 54;   // +200% draw distance so objects don't vanish when zoomed out

    showViewer(true);
    setStatus(statusLine(counts));
    // Export section stays hidden — downloads are handled by the floating
    // "Download" button on the 3D view.
  } catch (e) {
    console.error(e);
    setStatus('Generation failed: ' + (e.message || e) + ' — try a smaller area or wait a moment (the free OSM server rate-limits).', true);
  } finally {
    setLoading(false);
    $('generateBtn').disabled = false;
  }
}
$('generateBtn').addEventListener('click', generate);
$('clearCache')?.addEventListener('click', clearRequestCache);

/* ============================================================ layer inspector UI */

// Control kinds: color | range | select | toggleRow (layer visibility lives in the header)
const INSPECTOR = [
  { key: 'buildings', label: 'Buildings', toggle: true, group: '3D Suburb', items: [
    ['color', 'Colour', 'color'],
    ['nodes', 'Unmapped buildings (address nodes)', 'check'],
    ['nodeSize', 'Unmapped box size (m)', 'range', 4, 30, 1],
    ['defH', 'Default height (m)', 'range', 2, 40, 1],
    ['scale', 'Height scale', 'range', 0.2, 3, 0.05],
    ['extra', 'Extra height (m)', 'range', 0, 40, 1],
    ['minH', 'Minimum height (m)', 'range', 0, 30, 1],
    ['fit', 'Ground fit', 'select', [['terrain', 'Follow terrain'], ['flat', 'Flat (lowest point)']]],
  ]},
  { key: 'majorRoads', label: 'Roads', toggle: true, toggleAlso: ['minorRoads'], items: [
    ['color', 'Major colour', 'color'],
    ['widthScale', 'Major width scale', 'range', 0.2, 3, 0.05],
    ['lift', 'Major raise above ground (m)', 'range', 0, 5, 0.1],
    ['color', 'Minor colour', 'color', { ck: 'minorRoads' }],
    ['widthScale', 'Minor width scale', 'range', 0.2, 3, 0.05, { ck: 'minorRoads' }],
    ['lift', 'Minor raise above ground (m)', 'range', 0, 5, 0.1, { ck: 'minorRoads' }],
  ]},
  { key: 'paths', label: 'Paths & tracks', toggle: true, items: [
    ['color', 'Colour', 'color'],
    ['widthScale', 'Width scale', 'range', 0.2, 3, 0.05],
    ['lift', 'Raise above ground (m)', 'range', 0, 5, 0.1],
  ]},
  { key: 'green', label: 'Green space', toggle: true, items: [
    ['color', 'Colour', 'color'],
    ['lift', 'Raise above ground (m)', 'range', 0, 5, 0.1],
  ]},
  { key: 'water', label: 'Water', toggle: true, items: [
    ['color', 'Colour', 'color'],
    ['lift', 'Raise above ground (m)', 'range', 0, 5, 0.1],
  ]},
  { key: 'terrain', label: 'Terrain', toggle: true, items: [
    ['color', 'Colour', 'color'],
    ['exag', 'Vertical exaggeration', 'range', 0, 3, 0.05],
    ['res', 'Level of detail', 'range', 32, 160, 16],
    ['color', 'Base colour', 'color', { ck: 'base' }],
    ['depth', 'Base depth (m)', 'range', 1, 100, 1, { ck: 'base' }],
  ]},
  { key: 'backing', label: 'Backing map', toggle: true, group: 'Printable map', items: [
    ['title', 'Title', 'select', [['none', 'No title'], ['postcode', 'Postcode title'], ['suburb', 'Suburb title'], ['custom', 'Custom title']]],
    ['customTitle', 'Custom title text', 'text', 30, { showWhen: ['title', 'custom'] }],
    ['title3d', '3D printable title', 'check'],
    ['nodes', 'Unmapped buildings (address nodes)', 'check'],
    ['outline', 'White outline (mm)', 'range', 0, 20, 0.5],
  ]},
  { key: 'frame', label: 'Frame', toggle: true, group: 'Other', items: [
    ['material', 'Material', 'select', [['black', 'Black'], ['white', 'White'], ['silver', 'Silver'], ['wood', 'Wood texture']]],
    ['thickness', 'Thickness (mm)', 'range', 2, 40, 1],
    ['height', 'Height (mm)', 'range', 2, 40, 1],
  ]},
  { key: 'backdrop', label: 'Environment', toggle: true, items: [
    ['style', 'Background', 'select', [['white', 'White wall'], ['brick', 'Brick wall'], ['wood', 'Wooden wall'], ['textured', 'Textured wall']]],
  ]},
];

const MATERIAL_KEYS = new Set(['color', 'metal', 'rough']);

function applyMaterial(layerKey) {
  const m = MATS[layerKey], c = cfg[layerKey];
  m.color.set(c.color);
  m.metalness = c.metal ?? 0;
  m.roughness = c.rough ?? 1;
  m.needsUpdate = true;
}

function buildInspectorUI() {
  const host = $('layersUI');
  for (const layer of INSPECTOR) {
    const c = cfg[layer.key];
    if (layer.group) {
      const sub = document.createElement('div');
      sub.className = 'layer-group';
      sub.textContent = layer.group;
      host.appendChild(sub);
    }
    const wrap = document.createElement('div');
    wrap.className = 'layer';

    const head = document.createElement('div');
    head.className = 'layer-head';

    if (layer.toggle) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = c.on;
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', () => {
        c.on = cb.checked;
        for (const k of (layer.toggleAlso || [])) cfg[k].on = cb.checked;   // e.g. Roads toggles major + minor
        layerChanged(layer.key);
      });
      head.appendChild(cb);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'cb-spacer';
      head.appendChild(spacer);
    }

    let sw = null;
    if (c.color !== undefined) {
      sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = c.color;
      head.appendChild(sw);
    }
    // no colour → no swatch and no spacer, so the name isn't indented

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.label;
    head.appendChild(name);

    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '▸';
    head.appendChild(chev);

    const body = document.createElement('div');
    body.className = 'layer-body';
    body.style.display = 'none';

    // accordion: opening one layer closes any other that's open
    head.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      host.querySelectorAll('.layer-body').forEach(b => b.style.display = 'none');
      host.querySelectorAll('.chev').forEach(ch => ch.textContent = '▸');
      if (!open) { body.style.display = 'block'; chev.textContent = '▾'; }
    });

    // items with a trailing {showWhen: [prop, value]} option only display while
    // another item in this layer holds that value (e.g. the custom title text
    // box only makes sense once Title is set to "Custom title").
    const showWhenRows = [];
    const refreshShowWhen = () => {
      for (const { row, ck, dep, want } of showWhenRows) row.style.display = (cfg[ck][dep] === want) ? '' : 'none';
    };

    for (const item of layer.items) {
      const [prop, label, kind] = item;
      // an item can target a different config object via a trailing {ck:'base'} option
      const last = item[item.length - 1];
      const opts = (last && typeof last === 'object' && !Array.isArray(last)) ? last : null;
      const ck = (opts && opts.ck) || layer.key;
      const cc = cfg[ck];

      const row = document.createElement('div');
      row.className = 'ctl-row';
      const lab = document.createElement('label');
      lab.textContent = label;
      row.appendChild(lab);

      if (opts && opts.showWhen) {
        const [dep, want] = opts.showWhen;
        row.style.display = (cc[dep] === want) ? '' : 'none';
        showWhenRows.push({ row, ck, dep, want });
      }

      if (kind === 'color') {
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = cc[prop];
        inp.addEventListener('input', () => {
          cc[prop] = inp.value;
          if (sw && ck === layer.key) sw.style.background = inp.value;
          applyMaterial(ck);
        });
        row.appendChild(inp);
      } else if (kind === 'check') {
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.checked = !!cc[prop];
        inp.style.accentColor = '#4f8cff';
        inp.style.width = '15px';
        inp.style.height = '15px';
        inp.style.cursor = 'pointer';
        inp.addEventListener('change', () => { cc[prop] = inp.checked; layerChanged(layer.key); });
        row.appendChild(inp);
      } else if (kind === 'select') {
        const sel = document.createElement('select');
        sel.id = `ctl_${ck}_${prop}`;
        for (const [val, text] of item[3]) {
          const o = document.createElement('option');
          o.value = val; o.textContent = text;
          sel.appendChild(o);
        }
        sel.value = cc[prop];
        sel.addEventListener('change', () => { cc[prop] = sel.value; layerChanged(layer.key); refreshShowWhen(); });
        row.appendChild(sel);
      } else if (kind === 'text') {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.maxLength = item[3] || 100;
        inp.value = cc[prop] || '';
        inp.addEventListener('input', () => { cc[prop] = inp.value; layerChanged(layer.key); });
        row.appendChild(inp);
      } else { // range
        const [, , , min, max, step] = item;
        const inp = document.createElement('input');
        inp.type = 'range';
        inp.min = min; inp.max = max; inp.step = step;
        inp.value = cc[prop];
        const val = document.createElement('span');
        val.className = 'ctl-val';
        val.textContent = cc[prop];
        inp.addEventListener('input', () => {
          cc[prop] = Number(inp.value);
          val.textContent = inp.value;
          if (MATERIAL_KEYS.has(prop)) applyMaterial(ck);
          else geomChanged(ck);
        });
        row.appendChild(inp);
        row.appendChild(val);
      }
      body.appendChild(row);
    }

    wrap.appendChild(head);
    wrap.appendChild(body);
    host.appendChild(wrap);
  }
}
buildInspectorUI();
// warm up the title font so the flat + 3D titles are ready on first generate
loadTitleFont().catch(() => {});

/* ============================================================ base map layer */

// lat/lon bbox covering the whole A3 sheet at the model's print scale, so we can
// fetch the surrounding map that extends beyond the 3D render.
function a3BaseBbox(bbox, M) {
  const mPerMM = M / MODEL_PRINT_MM;                    // metres per printed mm
  const xHalf = (A3_W / 2) * mPerMM;
  const yNorth = MODEL_CY_MM * mPerMM;                  // from model centre up to the top edge
  const ySouth = (A3_H - MODEL_CY_MM) * mPerMM;         // down to the bottom edge
  const mLat = 111320, mLon = 111320 * Math.cos(bbox.lat0 * Math.PI / 180);
  return {
    north: bbox.lat0 + yNorth / mLat, south: bbox.lat0 - ySouth / mLat,
    east: bbox.lon0 + xHalf / mLon, west: bbox.lon0 - xHalf / mLon,
    lat0: bbox.lat0, lon0: bbox.lon0,
  };
}

// Draw a flat greyscale map of the whole A3 sheet (raw geometry, no boundary
// clip — this is the surrounding context the 3D model sits within).
function buildFlatMapCanvas(project, elements, extraBuildingPolys, M) {
  const s = MODEL_PRINT_MM / M;          // printed mm per metre
  const pxmm = 8;
  const W = Math.round(A3_W * pxmm), H = Math.round(A3_H * pxmm);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // local metres (origin = model centre, +y = north) → canvas px
  const toPx = ([x, y]) => [(MODEL_CX_MM + x * s) * pxmm, (MODEL_CY_MM - y * s) * pxmm];
  const ringPath = ring => { ctx.moveTo(...toPx(ring[0])); for (let i = 1; i < ring.length; i++) ctx.lineTo(...toPx(ring[i])); ctx.closePath(); };

  ctx.fillStyle = '#f0f0f0'; ctx.fillRect(0, 0, W, H);   // land background

  const fillPolys = (match, style) => {
    ctx.fillStyle = style; ctx.beginPath();
    for (const poly of collectPolygons(elements, match)) {
      ringPath(ringFromGeometry(poly.outer, project));
      for (const h of poly.holes || []) ringPath(ringFromGeometry(h, project));
    }
    ctx.fill('evenodd');
  };
  const strokeLines = (predicate, widthFn, style) => {
    ctx.strokeStyle = style; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const el of elements) {
      if (el.type !== 'way' || !el.tags || !el.geometry || !predicate(el.tags)) continue;
      ctx.lineWidth = Math.max(1, widthFn(el.tags) * s * pxmm);
      const pts = ringFromGeometry(el.geometry, project);
      ctx.beginPath(); ctx.moveTo(...toPx(pts[0]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(...toPx(pts[i]));
      ctx.stroke();
    }
  };

  fillPolys(GREEN_MATCH, '#dcdcdc');
  fillPolys(WATER_MATCH, '#c6c6c6');
  strokeLines(t => WATERWAY_WIDTHS[t.waterway] && t.tunnel !== 'yes' && t.tunnel !== 'culvert',
    t => WATERWAY_WIDTHS[t.waterway], '#c6c6c6');
  strokeLines(t => t.highway && roadClass(t.highway) === 'paths' && t.area !== 'yes',
    t => (ROAD_WIDTHS[t.highway] || 5) * cfg.paths.widthScale, '#c8c8c8');
  strokeLines(t => t.highway && roadClass(t.highway) === 'minorRoads' && t.area !== 'yes',
    t => (ROAD_WIDTHS[t.highway] || 5) * cfg.minorRoads.widthScale, '#8c8c8c');
  strokeLines(t => t.highway && roadClass(t.highway) === 'majorRoads' && t.area !== 'yes',
    t => (ROAD_WIDTHS[t.highway] || 5) * cfg.majorRoads.widthScale, '#6a6a6a');

  // buildings (OSM + any pre-baked), drawn raw
  ctx.fillStyle = '#9a9a9a'; ctx.beginPath();
  for (const poly of collectPolygons(elements, t => t['building'] !== undefined)) {
    ringPath(ringFromGeometry(poly.outer, project));
    for (const h of poly.holes || []) ringPath(ringFromGeometry(h, project));
  }
  if (extraBuildingPolys) for (const poly of extraBuildingPolys) {
    ringPath(ringFromGeometry(poly.outer, project));
    for (const h of poly.holes || []) ringPath(ringFromGeometry(h, project));
  }
  ctx.fill('evenodd');

  // Unmapped buildings: a square at each address/building node that has no drawn
  // footprint — same technique as the 3D boxes, matched to their size.
  if (cfg.backing.nodes) {
    const footprints = [];
    for (const poly of collectPolygons(elements, t => t['building'] !== undefined)) footprints.push(ringFromGeometry(poly.outer, project));
    if (extraBuildingPolys) for (const poly of extraBuildingPolys) footprints.push(ringFromGeometry(poly.outer, project));
    const size = cfg.buildings.nodeSize, half = size / 2, cell = Math.max(2, size * 0.8);
    const seen = new Set();
    ctx.fillStyle = '#9a9a9a';
    for (const el of elements) {
      if (el.type !== 'node' || !el.tags) continue;
      if (el.tags['addr:housenumber'] === undefined && el.tags['building'] === undefined) continue;
      if (el.lat === undefined || el.lon === undefined) continue;
      const [x, y] = project(el.lat, el.lon);
      let covered = false;
      for (const ring of footprints) { if (pointInRing(x, y, ring)) { covered = true; break; } }
      if (covered) continue;
      const key = Math.round(x / cell) + ':' + Math.round(y / cell);
      if (seen.has(key)) continue;
      seen.add(key);
      const a = toPx([x - half, y - half]), b = toPx([x + half, y + half]);
      ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    }
  }

  // Optional large greyscale title on the empty band above the 3D render, drawn
  // from the SAME font as the 3D title so the two line up exactly. Never let a
  // title-drawing hiccup abort the whole backing map.
  try { drawBackingTitle(ctx, toPx, s, pxmm); } catch (e) { console.warn('Backing title skipped', e); }

  return canvas;
}

// Which title (if any) to print on the backing map.
function backingTitleText() {
  const mode = cfg.backing.title;
  if (mode === 'postcode') {
    return (state.council && state.council.postcode)
      || (state.placeLabels && state.placeLabels.postcode) || '';
  }
  if (mode === 'suburb') {
    const name = (state.council && state.council.name)
      || (state.placeLabels && state.placeLabels.suburb) || '';
    return name.toUpperCase();
  }
  if (mode === 'custom') return (cfg.backing.customTitle || '').toUpperCase();
  return '';
}

// Bounding box of a set of font shapes (outer contours).
function shapesBounds(shapes) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const sh of shapes) {
    for (const p of sh.getPoints(6)) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, maxX, minY, maxY };
}

// Shared layout for BOTH the flat and 3D titles: same font glyphs, same size,
// same centre — so the 3D title sits exactly over the printed one. Returns local
// metres (origin = model centre, +y = north). Needs the title font loaded.
function titleLayout(font) {
  const text = backingTitleText();
  if (!text || !font || !state.baseData) return null;
  const M = state.baseData.M;
  const metresPerMM = M / MODEL_PRINT_MM;
  const W = 2 * EXT.hx;                                   // width = model footprint width
  const sheetTopLocalY = MODEL_CY_MM * metresPerMM;       // north edge of the A3 sheet
  const modelNorthLocalY = EXT.hy;                        // north edge of the model
  const bandCentreY = (sheetTopLocalY + modelNorthLocalY) / 2;
  const maxH = 0.7 * Math.max(1, sheetTopLocalY - modelNorthLocalY);
  let probe;
  try { probe = font.generateShapes(text, 100); } catch (e) { return null; }
  const pb = shapesBounds(probe);
  const w0 = (pb.maxX - pb.minX) || 1, h0 = (pb.maxY - pb.minY) || 1;
  let size = 100 * W / w0;
  if (h0 * size / 100 > maxH) size = 100 * maxH / h0;    // clamp so it fits the band
  const shapes = font.generateShapes(text, size);
  const b = shapesBounds(shapes);
  return { text, size, shapes, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, bandCentreY };
}

// Draw the flat greyscale title (white outline + grey fill) from the font shapes.
function drawBackingTitle(ctx, toPx, s, pxmm) {
  const lay = titleLayout(_titleFont);
  if (!lay) return;
  const buildPath = () => {
    ctx.beginPath();
    for (const shape of lay.shapes) {
      const ep = shape.extractPoints(6);
      const contour = (pts) => {
        pts.forEach((p, i) => {
          const px = toPx([p.x - lay.cx, p.y - lay.cy + lay.bandCentreY]);
          if (i === 0) ctx.moveTo(px[0], px[1]); else ctx.lineTo(px[0], px[1]);
        });
        ctx.closePath();
      };
      contour(ep.shape);
      for (const h of ep.holes) contour(h);
    }
  };
  ctx.save();
  ctx.lineJoin = 'round';
  const outlinePx = (cfg.backing.outline || 0) * pxmm;       // outline in mm → px
  if (outlinePx > 0) { buildPath(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = outlinePx; ctx.stroke(); }
  buildPath(); ctx.fillStyle = '#7a7a7a'; ctx.fill('evenodd');   // always greyscale
  ctx.restore();
}

function buildBaseLayer(bbox, elements, prebaked, M) {
  const project = makeProjector(bbox.lat0, bbox.lon0);
  const extra = prebaked ? prebakedToPolys(prebaked, project) : null;
  const canvas = buildFlatMapCanvas(project, elements, extra, M);
  const baseY = -Math.max(0.5, cfg.base.depth) - 0.2;   // just under the model

  if (state.baseLayer) {
    scene.remove(state.baseLayer);
    state.baseLayer.geometry.dispose();
    if (state.baseLayer.material.map) state.baseLayer.material.map.dispose();
    state.baseLayer.material.dispose();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = MODEL_PRINT_MM / M;                          // mm per metre
  const mPerMM = 1 / s;
  // world extents of the A3 sheet (world z = -y; north = -z)
  const xHalf = (A3_W / 2) * mPerMM;
  const zNorth = -MODEL_CY_MM * mPerMM;                  // top edge (north)
  const zSouth = (A3_H - MODEL_CY_MM) * mPerMM;          // bottom edge (south)
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -xHalf, baseY, zNorth,  xHalf, baseY, zNorth,  -xHalf, baseY, zSouth,  xHalf, baseY, zSouth], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
  g.setIndex([0, 2, 3, 0, 3, 1]);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  mesh.name = 'basemap';
  state.baseLayer = mesh;
  scene.add(mesh);

  state.basePdf = { canvas, wmm: A3_W, hmm: A3_H };      // A3 portrait
}

function removeBaseLayer() {
  if (state.baseLayer) {
    scene.remove(state.baseLayer);
    state.baseLayer.geometry.dispose();
    if (state.baseLayer.material.map) state.baseLayer.material.map.dispose();
    state.baseLayer.material.dispose();
    state.baseLayer = null;
  }
  state.basePdf = null;
}

// (Re)build the backing map from cached inputs — used on first generate and
// whenever the Backing map layer's toggle or title changes. The sheet is built
// immediately (so it always appears); if the title font isn't ready yet the
// sheet is redrawn with the title once the font loads.
function rebuildBaseLayer() {
  removeBaseLayer();
  if (cfg.backing.on && state.baseData) {
    const { bbox, elements, prebaked, M } = state.baseData;
    buildBaseLayer(bbox, elements, prebaked, M);
    if (backingTitleText() && !_titleFont) {
      loadTitleFont().then(() => {
        if (cfg.backing.on && state.baseData) {
          removeBaseLayer();
          const d = state.baseData;
          buildBaseLayer(d.bbox, d.elements, d.prebaked, d.M);
          updateBaseUI();
        }
      }).catch(() => {});
    }
  }
  updateBaseUI();
}

// Show the base-map PDF export only when the backing map is switched on.
function updateBaseUI() {
  const on = !!cfg.backing.on;
  if ($('expPdf')) $('expPdf').style.display = on ? 'block' : 'none';
  if ($('pdfHint')) $('pdfHint').style.display = on ? 'block' : 'none';
}

/* ---------- decorative frame (preview only; never exported) ---------- */

// A picture-frame border around the A3 base sheet, ~15 mm thick and 15 mm tall
// at print scale. Added straight to the scene (not state.model / not the PDF
// canvas), so it never appears in the GLB/STL/OBJ or the printed base map.
function boxBetween(x0, x1, y0, y1, z0, z1, mat) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return new THREE.Mesh(g, mat);
}

function woodTexture() {
  const S = 1024;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  const tones = [[142, 98, 58], [124, 84, 46], [158, 112, 68], [112, 74, 42], [148, 102, 60], [132, 90, 52]];
  let x = 0, p = 0;
  while (x < S) {
    const pw = 150 + Math.random() * 90;                 // varied plank widths
    const t = tones[p % tones.length];
    const grd = g.createLinearGradient(x, 0, x + pw, 0);
    grd.addColorStop(0, `rgb(${t[0] - 12},${t[1] - 9},${t[2] - 7})`);
    grd.addColorStop(0.5, `rgb(${t[0]},${t[1]},${t[2]})`);
    grd.addColorStop(1, `rgb(${t[0] - 10},${t[1] - 7},${t[2] - 5})`);
    g.fillStyle = grd; g.fillRect(x, 0, pw, S);
    // cathedral grain: nested arcs around a plank centre
    const cx = x + pw * (0.3 + Math.random() * 0.4);
    for (let i = 0; i < 46; i++) {
      const off = (i - 23) * (pw / 46);
      g.strokeStyle = `rgba(58,36,16,${0.08 + Math.random() * 0.13})`;
      g.lineWidth = 0.6 + Math.random() * 1.4;
      g.beginPath();
      const gx = cx + off;
      g.moveTo(gx, -20);
      g.bezierCurveTo(cx + off * 0.55, S * 0.35, cx + off * 1.5, S * 0.66, gx + (Math.random() * 8 - 4), S + 20);
      g.stroke();
    }
    // knots
    if (Math.random() < 0.5) {
      const ky = Math.random() * S, kx = x + pw * (0.3 + Math.random() * 0.4);
      for (let r = 26; r > 0; r -= 2.5) {
        g.strokeStyle = `rgba(42,24,9,${0.55 - r * 0.014})`; g.lineWidth = 1.6;
        g.beginPath(); g.ellipse(kx, ky, r * 0.6, r, Math.random() * 0.5, 0, Math.PI * 2); g.stroke();
      }
    }
    // groove between planks (shadow + highlight)
    g.fillStyle = 'rgba(0,0,0,0.30)'; g.fillRect(x, 0, 4, S);
    g.fillStyle = 'rgba(255,236,208,0.06)'; g.fillRect(x + 4, 0, 2, S);
    x += pw; p++;
  }
  // faint overall fibre speckle
  for (let i = 0; i < 20000; i++) { const sx = Math.random() * S, sy = Math.random() * S, a = Math.random() * 0.05; g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,240,215,${a})`; g.fillRect(sx, sy, 1.2, 1.2); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function frameMaterial(kind) {
  if (kind === 'wood') {
    return new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide });
  }
  if (kind === 'silver') return new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.3, metalness: 0.9, side: THREE.DoubleSide });
  if (kind === 'white')  return new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide });
  return new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide }); // black
}

function removeFrame() {
  if (state.frame) {
    scene.remove(state.frame);
    state.frame.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
    state.frame = null;
  }
}

function buildFrame(M) {
  const mPerMM = M / MODEL_PRINT_MM;
  const xHalf = (A3_W / 2) * mPerMM;
  const zNorth = -MODEL_CY_MM * mPerMM;
  const zSouth = (A3_H - MODEL_CY_MM) * mPerMM;
  const t = (cfg.frame.thickness || 10) * mPerMM;        // frame thickness
  const h = (cfg.frame.height || 10) * mPerMM;           // frame height
  const yb = -Math.max(0.5, cfg.base.depth) - 0.2;       // base-sheet level
  const y0 = yb, y1 = yb + h;
  const mat = frameMaterial(cfg.frame.material);
  const grp = new THREE.Group();
  grp.name = 'frame';
  const ox0 = -xHalf - t, ox1 = xHalf + t, oz0 = zNorth - t, oz1 = zSouth + t;
  grp.add(boxBetween(ox0, ox1, y0, y1, oz0, zNorth, mat));   // north strip (full outer width)
  grp.add(boxBetween(ox0, ox1, y0, y1, zSouth, oz1, mat));   // south strip
  grp.add(boxBetween(ox0, -xHalf, y0, y1, zNorth, zSouth, mat)); // west strip
  grp.add(boxBetween(xHalf, ox1, y0, y1, zNorth, zSouth, mat));  // east strip
  state.frame = grp;
  scene.add(grp);
}

// (Re)build the frame from cached inputs — on generate and on any Frame change.
function rebuildFrame() {
  removeFrame();
  if (cfg.frame.on && state.baseData) buildFrame(state.baseData.M);
}

/* ---------- backdrop wall + floor (preview only; never exported) ---------- */

function brickTexture() {
  const S = 1024;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  // mortar base — cementy grey with grain and soft shading
  g.fillStyle = '#bcb4a4'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 16000; i++) { const x = Math.random() * S, y = Math.random() * S, a = Math.random() * 0.08; g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`; g.fillRect(x, y, 1.5, 1.5); }
  const bw = 210, bh = 74, m = 16;   // brick + mortar gap
  const brickCols = [[152, 62, 48], [170, 74, 54], [134, 52, 42], [178, 88, 62], [120, 46, 40], [158, 68, 50], [110, 58, 52]];
  let row = 0;
  for (let y = -bh; y < S + bh; y += bh + m) {
    const off = (row % 2) ? -(bw + m) / 2 : 0;
    for (let x = off - bw; x < S + bw; x += bw + m) {
      const base = brickCols[Math.floor(Math.random() * brickCols.length)];
      const jit = k => Math.max(0, Math.min(255, base[k] + (Math.random() * 34 - 17))) | 0;
      const yy = y + (Math.random() * 3 - 1.5), hh = bh + (Math.random() * 3 - 1.5);
      g.fillStyle = `rgb(${jit(0)},${jit(1)},${jit(2)})`;
      g.fillRect(x, yy, bw, hh);
      // mottling / weathering within the brick
      for (let k = 0; k < 90; k++) { const sx = x + Math.random() * bw, sy = yy + Math.random() * hh, a = Math.random() * 0.14; g.fillStyle = Math.random() < 0.55 ? `rgba(0,0,0,${a})` : `rgba(255,236,214,${a * 0.7})`; g.fillRect(sx, sy, 3, 3); }
      // bevel: top/left highlight, bottom/right shadow
      g.fillStyle = 'rgba(255,238,222,0.10)'; g.fillRect(x, yy, bw, 4); g.fillRect(x, yy, 4, hh);
      g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(x, yy + hh - 4, bw, 4); g.fillRect(x + bw - 4, yy, 4, hh);
    }
    row++;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Rendered/troweled plaster wall: warm off-white with soft mottling, sweeping
// trowel marks and a fine sand speckle.
function plasterTexture() {
  const S = 1024;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#e8e3d9'; g.fillRect(0, 0, S, S);       // warm render base
  // draw a feature plus its 8 wrapped copies so anything crossing an edge
  // reappears on the opposite side → the tile repeats seamlessly
  const tiled = (fn) => { for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) fn(ox * S, oy * S); };

  // soft mottled patches (light + shadow)
  for (let i = 0; i < 170; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 60 + Math.random() * 180;
    const light = Math.random() < 0.5, a = 0.04 + Math.random() * 0.06;
    const col = light ? '255,252,244' : '118,108,92';
    tiled((dx, dy) => {
      const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      grd.addColorStop(0, `rgba(${col},${a})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(x + dx, y + dy, r, 0, Math.PI * 2); g.fill();
    });
  }
  // trowel sweeps — long faint curved strokes
  g.lineCap = 'round';
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * S, y = Math.random() * S, len = 120 + Math.random() * 300;
    const ang = (Math.random() * 0.7 - 0.35) + (Math.random() < 0.5 ? 0 : Math.PI / 2);
    const mx = x + Math.cos(ang) * len * 0.5 + (Math.random() * 40 - 20), my = y + Math.sin(ang) * len * 0.5;
    const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
    const style = Math.random() < 0.5 ? 'rgba(255,255,250,0.05)' : 'rgba(88,80,68,0.05)';
    const lw = 14 + Math.random() * 26;
    tiled((dx, dy) => {
      g.strokeStyle = style; g.lineWidth = lw;
      g.beginPath(); g.moveTo(x + dx, y + dy); g.quadraticCurveTo(mx + dx, my + dy, ex + dx, ey + dy); g.stroke();
    });
  }
  // fine sand speckle (uniform high-frequency noise — already seamless)
  for (let i = 0; i < 26000; i++) { const x = Math.random() * S, y = Math.random() * S, a = Math.random() * 0.06; g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`; g.fillRect(x, y, 1, 1); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function backdropMaterial(style) {
  // polygonOffset pushes the backdrop away in the depth buffer so it can never
  // overdraw the (nearly coplanar) base sheet / frame sitting in front of it.
  const common = { roughness: 0.9, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 3 };
  if (style === 'brick') return new THREE.MeshStandardMaterial({ ...common, map: brickTexture() });
  if (style === 'wood') return new THREE.MeshStandardMaterial({ ...common, map: woodTexture(), roughness: 0.7 });
  if (style === 'textured') return new THREE.MeshStandardMaterial({ ...common, map: plasterTexture(), roughness: 0.95 });
  return new THREE.MeshStandardMaterial({ ...common, color: 0xf4f4f2, roughness: 0.95 }); // white wall
}

function removeBackdrop() {
  if (state.backdrop) {
    scene.remove(state.backdrop);
    state.backdrop.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
    state.backdrop = null;
  }
}

function buildBackdrop(M) {
  const mPerMM = M / MODEL_PRINT_MM;
  const xHalf = (A3_W / 2) * mPerMM;
  const zNorth = -MODEL_CY_MM * mPerMM;
  const zSouth = (A3_H - MODEL_CY_MM) * mPerMM;
  const frameT = (cfg.frame.on ? (cfg.frame.thickness || 10) : 0) * mPerMM;
  const yb = -Math.max(0.5, cfg.base.depth) - 0.2;

  // Backdrop half-extent: the framed piece's padded footprint, widened out.
  const paddedHalf = xHalf + frameT + xHalf * 0.9;
  const halfW = paddedHalf * 8;                          // very wide backdrop
  const padZ = (zSouth - zNorth) * 0.45;
  const fx0 = -halfW, fx1 = halfW;
  // depth (the flat backdrop's on-screen "height") extended by 300% (×4 about its centre)
  const bz0 = zNorth - frameT - padZ, bz1 = zSouth + frameT + padZ;
  const midZ = (bz0 + bz1) / 2, halfD = (bz1 - bz0) / 2 * 4;
  const fz0 = midZ - halfD, fz1 = midZ + halfD;
  const floorW = fx1 - fx0, floorD = fz1 - fz0;
  const floorY = yb - Math.max(2, (zSouth - zNorth) * 0.02);   // clearly below the sheet
  // world size of one texture tile; larger tile = fewer repeats = bigger pattern.
  // Brick is zoomed 16× (400% × 400%) and wood 4× relative to the base tile.
  const styleScale = ({ brick: 16, wood: 4, textured: 12 })[cfg.backdrop.style] || 1;
  const tile = Math.max(xHalf * 0.5, 1) * styleScale;

  const grp = new THREE.Group();
  grp.name = 'backdrop';

  // floor only — a single flat surface parallel to the backing map (no vertical wall)
  const floorMat = backdropMaterial(cfg.backdrop.style);
  if (floorMat.map) floorMat.map.repeat.set(Math.max(1, Math.round(floorW / tile)), Math.max(1, Math.round(floorD / tile)));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorW, floorD), floorMat);
  floor.geometry.rotateX(-Math.PI / 2);                  // lie flat, normal up
  floor.geometry.translate((fx0 + fx1) / 2, floorY, (fz0 + fz1) / 2);

  grp.add(floor);
  state.backdrop = grp;
  scene.add(grp);
}

function rebuildBackdrop() {
  removeBackdrop();
  if (cfg.backdrop.on && state.baseData) buildBackdrop(state.baseData.M);
}

/* ---------- 3D printable title (preview + separate export) ---------- */

function loadTitleFont() {
  if (_titleFont) return Promise.resolve(_titleFont);
  if (!_titleFontPromise) {
    _titleFontPromise = new Promise((resolve, reject) => {
      new FontLoader().load(
        'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/fonts/helvetiker_bold.typeface.json',
        f => { _titleFont = f; resolve(f); }, undefined, reject);
    });
  }
  return _titleFontPromise;
}

function removeTitle3D() {
  if (state.titleObj) {
    scene.remove(state.titleObj);
    if (state.titleObj.geometry) state.titleObj.geometry.dispose();
    if (state.titleObj.material) state.titleObj.material.dispose();
    state.titleObj = null;
  }
}

// Build an extruded 3D version of the suburb/postcode title, standing on the
// base sheet in the band north of the model. Its standing height equals the
// map's highest elevation. Added to the scene only (not state.model), so it is
// excluded from the main 3D exports and printed base map — it has its own export.
async function buildTitle3D() {
  if (!state.baseData) return;
  let font;
  try { font = await loadTitleFont(); }
  catch (e) { console.warn('Title font failed to load', e); setStatus('Could not load the 3D title font.', true); return; }
  // guard against a stale rebuild (toggle flipped off while the font loaded)
  if (!cfg.backing.title3d || !cfg.backing.on) return;

  // identical layout to the flat title → the 3D title sits exactly over it
  const lay = titleLayout(font);
  if (!lay) return;
  const depth = Math.max(state.maxGround || 0, 15);     // standing height = highest elevation

  let geo = new TextGeometry(lay.text, { font, size: lay.size, height: depth, curveSegments: 5, bevelEnabled: false });
  // orient upright: extrusion → world +y (up); glyph tops point north; readable from above
  geo.rotateX(-Math.PI / 2);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;

  // footprint centre → world (x=0, z=-bandCentreY); base sits on the base sheet
  const worldZ = -lay.bandCentreY;                      // north = -z
  const yb = -Math.max(0.5, cfg.base.depth) - 0.2;
  geo.translate(
    0 - (bb.min.x + bb.max.x) / 2,
    yb - bb.min.y,
    worldZ - (bb.min.z + bb.max.z) / 2,
  );
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(cfg.majorRoads.color), roughness: 0.8, metalness: 0.05, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'Title';
  state.titleObj = mesh;
  scene.add(mesh);
}

function rebuildTitle3D() {
  removeTitle3D();
  if (cfg.backing.on && cfg.backing.title3d && state.baseData) buildTitle3D();
  updateTitleExportUI();
}

// Show the separate 3D-title export only when the 3D title is switched on.
function updateTitleExportUI() {
  const on = !!(cfg.backing.on && cfg.backing.title3d);
  if ($('expTitle')) $('expTitle').style.display = on ? 'block' : 'none';
  if ($('titleHint')) $('titleHint').style.display = on ? 'block' : 'none';
  if (typeof updateDownloadMenu === 'function') updateDownloadMenu();
}

/* ============================================================ export */

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Export the model as a colour 3MF: one object per layer colour, each tagged with
// its own base material so Bambu Studio (and other slicers) keep the layer colours
// and can map them to filaments/AMS. Oriented Z-up so it loads flat with the
// buildings on top, and pre-scaled so the model is 200 mm across (like the STL).
function writeColour3MF(root, filename) {
  const modelMax = Math.max(2 * EXT.hx, 2 * EXT.hy);
  const scale = 200 / modelMax;
  root.updateMatrixWorld(true);

  // group all triangles by LAYER (so each layer becomes its own named, coloured
  // object that Bambu Studio can map to a filament)
  const groups = new Map();
  const v = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, minZ = Infinity, maxZ = -Infinity;
  root.traverse(o => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const col = (o.material && o.material.color) ? o.material.color.getHexString() : 'cccccc';
    const key = MAT2KEY.get(o.material) || ('colour_' + col);
    const name = LAYER_LABELS[key] || o.name || key;
    let g = groups.get(key);
    if (!g) { g = { key, name, color: col, verts: [], tris: [] }; groups.set(key, g); }
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const base = g.verts.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
      g.verts.push(v.x, v.y, v.z);
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }
    if (idx) for (let i = 0; i < idx.count; i += 3) g.tris.push(base + idx.getX(i), base + idx.getX(i + 1), base + idx.getX(i + 2));
    else for (let i = 0; i < pos.count; i += 3) g.tris.push(base + i, base + i + 1, base + i + 2);
  });
  if (!groups.size) { setStatus('Nothing to export.', true); return 0; }

  const midX = (minX + maxX) / 2, midZ = (minZ + maxZ) / 2;
  // three (x,y,z) → 3MF Z-up (X,Y,Z): rotate Y→Z (flat, buildings up),
  // centre in X/Y and drop the base onto Z=0, then scale to mm.
  const mapV = (x, y, z) => [((x - midX) * scale), (-(z - midZ) * scale), ((y - minY) * scale)];

  const esc = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const arr = [...groups.values()];
  const matXml = arr.map((g) => `<base name="${esc(g.name)}" displaycolor="#${g.color.toUpperCase()}FF"/>`).join('');
  let objXml = '', itemXml = '';
  arr.forEach((g, i) => {
    const oid = i + 2;
    const vs = [];
    for (let k = 0; k < g.verts.length; k += 3) {
      const p = mapV(g.verts[k], g.verts[k + 1], g.verts[k + 2]);
      vs.push(`<vertex x="${p[0].toFixed(3)}" y="${p[1].toFixed(3)}" z="${p[2].toFixed(3)}"/>`);
    }
    const ts = [];
    for (let k = 0; k < g.tris.length; k += 3) ts.push(`<triangle v1="${g.tris[k]}" v2="${g.tris[k + 1]}" v3="${g.tris[k + 2]}"/>`);
    objXml += `<object id="${oid}" name="${esc(g.name)}" type="model" pid="1" pindex="${i}"><mesh><vertices>${vs.join('')}</vertices><triangles>${ts.join('')}</triangles></mesh></object>`;
    itemXml += `<item objectid="${oid}"/>`;
  });

  const model = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">`
    + `<resources><basematerials id="1">${matXml}</basematerials>${objXml}</resources>`
    + `<build>${itemXml}</build></model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

  const zipped = zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  });
  download(new Blob([zipped], { type: 'model/3mf' }), filename);
  return arr.length;
}

function exportColour3MF() {
  if (!state.model) return;
  setStatus('Exporting colour 3MF…');
  try {
    const n = writeColour3MF(state.model, state.modelName + '.3mf');
    if (n) setStatus(`Colour 3MF exported — ${n} colour groups, flat, 200 mm across.`);
  } catch (e) { console.error(e); setStatus('3MF export failed: ' + e.message, true); }
}

function exportTitle3MF() {
  if (!state.titleObj) { setStatus('Turn on the 3D printable title first.', true); return; }
  setStatus('Exporting 3D text 3MF…');
  try {
    writeColour3MF(state.titleObj, state.modelName + '-title.3mf');
    setStatus('3D text 3MF exported (flat, scaled to match the 200 mm model).');
  } catch (e) { console.error(e); setStatus('3D text export failed: ' + e.message, true); }
}

$('expGlb')?.addEventListener('click', () => {
  if (!state.model) return;
  setStatus('Exporting GLB…');
  new GLTFExporter().parse(
    state.model,
    (result) => {
      download(new Blob([result], { type: 'model/gltf-binary' }), state.modelName + '.glb');
      setStatus('GLB exported.');
    },
    (err) => setStatus('GLB export failed: ' + err, true),
    { binary: true }
  );
});

$('expStl')?.addEventListener('click', () => {
  if (!state.model) return;
  setStatus('Exporting STL…');
  try {
    const modelMax = Math.max(2 * EXT.hx, 2 * EXT.hy); // model's widest side in metres
    const clone = state.model.clone(true);
    clone.rotation.x = Math.PI / 2;         // Y-up → Z-up so it loads flat, buildings up
    clone.scale.setScalar(200 / modelMax);
    clone.updateMatrixWorld(true);
    const result = new STLExporter().parse(clone, { binary: true });
    download(new Blob([result], { type: 'application/octet-stream' }), state.modelName + '.stl');
    setStatus('STL exported (single colour, flat, scaled to 200 mm across).');
  } catch (e) { setStatus('STL export failed: ' + e.message, true); }
});

$('expObj')?.addEventListener('click', () => {
  if (!state.model) return;
  setStatus('Exporting OBJ…');
  try {
    const result = new OBJExporter().parse(state.model);
    download(new Blob([result], { type: 'text/plain' }), state.modelName + '.obj');
    setStatus('OBJ exported.');
  } catch (e) { setStatus('OBJ export failed: ' + e.message, true); }
});

$('exp3mf')?.addEventListener('click', exportColour3MF);

function exportBasePdf() {
  if (!state.basePdf) { setStatus('Turn on the Backing map layer first.', true); return; }
  setStatus('Exporting base map PDF…');
  try {
    const { canvas, wmm, hmm } = state.basePdf;
    const pdf = new jsPDF({ orientation: wmm >= hmm ? 'l' : 'p', unit: 'mm',
      format: [Math.min(wmm, hmm), Math.max(wmm, hmm)] });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pw, ph);
    pdf.save(state.modelName + '-basemap.pdf');
    setStatus(`Base map PDF exported (${pw.toFixed(0)}×${ph.toFixed(0)} mm — print at 100%).`);
  } catch (e) { setStatus('PDF export failed: ' + e.message, true); }
}
$('expPdf')?.addEventListener('click', exportBasePdf);
$('expTitle')?.addEventListener('click', exportTitle3MF);

// download menu on the 3D view
document.querySelectorAll('#dlOptions button').forEach(b => {
  b.addEventListener('click', () => {
    const k = b.dataset.dl;
    if (k === 'pdf') exportBasePdf();
    else if (k === 'model') exportColour3MF();
    else if (k === 'text') exportTitle3MF();
  });
});

// the "3D Text · 3MF" download option only makes sense when the 3D title is on
function updateDownloadMenu() {
  const t = document.querySelector('#dlOptions button[data-dl="text"]');
  if (t) t.style.display = (cfg.backing.on && cfg.backing.title3d) ? 'block' : 'none';
}
updateDownloadMenu();
