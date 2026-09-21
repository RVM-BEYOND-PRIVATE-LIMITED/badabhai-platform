/// States, union territories and major cities of India — the option lists
/// behind the name screen's State → City pickers (master spec rule 3: State
/// always precedes City).
///
/// The STATE list is complete and closed (28 states + 8 UTs). The CITY lists
/// are suggestions, never a gate: the city picker always accepts what the
/// worker typed, keeping #1428's promise that the first screen never refuses
/// the name of the town a worker lives in. The server does not gazetteer-check.
///
/// Recently renamed cities list BOTH names so a worker finds the one they know.
library;

/// All 36 states and union territories, alphabetical.
const List<String> kIndianStates = <String>[
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam',
  'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
  'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal',
];

const Map<String, List<String>> _kCitiesByState = <String, List<String>>{
  'Andaman and Nicobar Islands': <String>['Sri Vijaya Puram', 'Port Blair', 'Car Nicobar', 'Diglipur', 'Mayabunder', 'Rangat'],
  'Andhra Pradesh': <String>['Visakhapatnam', 'Vijayawada', 'Guntur', 'Nellore', 'Kurnool', 'Tirupati', 'Kakinada', 'Rajahmundry', 'Kadapa', 'Anantapur', 'Eluru', 'Ongole', 'Srikakulam', 'Vizianagaram', 'Chittoor', 'Machilipatnam', 'Sri City'],
  'Arunachal Pradesh': <String>['Itanagar', 'Naharlagun', 'Pasighat', 'Tawang', 'Ziro', 'Bomdila', 'Tezu'],
  'Assam': <String>['Guwahati', 'Silchar', 'Dibrugarh', 'Jorhat', 'Nagaon', 'Tinsukia', 'Tezpur', 'Bongaigaon', 'Dhubri', 'Karimganj', 'Sivasagar', 'Goalpara'],
  'Bihar': <String>['Patna', 'Gaya', 'Bhagalpur', 'Muzaffarpur', 'Darbhanga', 'Purnia', 'Begusarai', 'Arrah', 'Bihar Sharif', 'Katihar', 'Munger', 'Chhapra', 'Hajipur', 'Sasaram', 'Siwan', 'Motihari', 'Bettiah'],
  'Chandigarh': <String>['Chandigarh'],
  'Chhattisgarh': <String>['Raipur', 'Bhilai', 'Durg', 'Bilaspur', 'Korba', 'Rajnandgaon', 'Raigarh', 'Jagdalpur', 'Ambikapur', 'Dhamtari'],
  'Dadra and Nagar Haveli and Daman and Diu': <String>['Silvassa', 'Daman', 'Diu', 'Dadra', 'Naroli'],
  'Delhi': <String>['Delhi', 'New Delhi'],
  'Goa': <String>['Panaji', 'Margao', 'Vasco da Gama', 'Mapusa', 'Ponda'],
  'Gujarat': <String>['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Bhavnagar', 'Jamnagar', 'Gandhinagar', 'Junagadh', 'Anand', 'Nadiad', 'Morbi', 'Mehsana', 'Bharuch', 'Ankleshwar', 'Vapi', 'Navsari', 'Gandhidham', 'Bhuj', 'Porbandar', 'Surendranagar', 'Veraval', 'Halol', 'Sanand'],
  'Haryana': <String>['Gurugram', 'Faridabad', 'Manesar', 'Panipat', 'Ambala', 'Yamunanagar', 'Rohtak', 'Hisar', 'Karnal', 'Sonipat', 'Panchkula', 'Bhiwani', 'Sirsa', 'Bahadurgarh', 'Jind', 'Rewari', 'Dharuhera', 'Kaithal', 'Palwal'],
  'Himachal Pradesh': <String>['Shimla', 'Solan', 'Baddi', 'Nalagarh', 'Mandi', 'Dharamshala', 'Kullu', 'Hamirpur', 'Una', 'Bilaspur', 'Chamba', 'Paonta Sahib'],
  'Jammu and Kashmir': <String>['Srinagar', 'Jammu', 'Anantnag', 'Baramulla', 'Sopore', 'Kathua', 'Udhampur', 'Samba', 'Rajouri', 'Pulwama', 'Kupwara', 'Poonch'],
  'Jharkhand': <String>['Ranchi', 'Jamshedpur', 'Dhanbad', 'Bokaro Steel City', 'Deoghar', 'Hazaribagh', 'Giridih', 'Ramgarh', 'Adityapur', 'Dumka', 'Chaibasa'],
  'Karnataka': <String>['Bengaluru', 'Mysuru', 'Hubballi', 'Dharwad', 'Mangaluru', 'Belagavi', 'Kalaburagi', 'Davanagere', 'Ballari', 'Vijayapura', 'Shivamogga', 'Tumakuru', 'Raichur', 'Bidar', 'Hosapete', 'Udupi', 'Hassan', 'Mandya', 'Chitradurga', 'Kolar', 'Doddaballapura'],
  'Kerala': <String>['Thiruvananthapuram', 'Kochi', 'Kozhikode', 'Thrissur', 'Kollam', 'Kannur', 'Alappuzha', 'Palakkad', 'Kottayam', 'Malappuram', 'Kasaragod', 'Pathanamthitta'],
  'Ladakh': <String>['Leh', 'Kargil'],
  'Lakshadweep': <String>['Kavaratti', 'Agatti', 'Minicoy', 'Amini', 'Andrott'],
  'Madhya Pradesh': <String>['Indore', 'Bhopal', 'Jabalpur', 'Gwalior', 'Ujjain', 'Pithampur', 'Mandideep', 'Sagar', 'Dewas', 'Satna', 'Ratlam', 'Rewa', 'Katni', 'Singrauli', 'Burhanpur', 'Khandwa', 'Chhindwara', 'Morena', 'Bhind', 'Guna', 'Shivpuri', 'Vidisha'],
  'Maharashtra': <String>['Mumbai', 'Pune', 'Nagpur', 'Nashik', 'Thane', 'Navi Mumbai', 'Pimpri-Chinchwad', 'Chhatrapati Sambhajinagar', 'Aurangabad', 'Solapur', 'Kolhapur', 'Amravati', 'Vasai-Virar', 'Kalyan-Dombivli', 'Bhiwandi', 'Sangli', 'Jalgaon', 'Akola', 'Latur', 'Dhule', 'Ahilyanagar', 'Ahmednagar', 'Chandrapur', 'Parbhani', 'Ichalkaranji', 'Jalna', 'Satara', 'Ratnagiri', 'Nanded', 'Wardha', 'Gondia', 'Chakan', 'Talegaon Dabhade', 'Ranjangaon', 'Khopoli', 'Boisar', 'Palghar', 'Sinnar', 'Butibori'],
  'Manipur': <String>['Imphal', 'Thoubal', 'Kakching', 'Churachandpur', 'Bishnupur', 'Ukhrul'],
  'Meghalaya': <String>['Shillong', 'Tura', 'Jowai', 'Nongstoin', 'Williamnagar'],
  'Mizoram': <String>['Aizawl', 'Lunglei', 'Champhai', 'Serchhip', 'Kolasib'],
  'Nagaland': <String>['Kohima', 'Dimapur', 'Mokokchung', 'Tuensang', 'Wokha', 'Mon'],
  'Odisha': <String>['Bhubaneswar', 'Cuttack', 'Rourkela', 'Berhampur', 'Sambalpur', 'Puri', 'Balasore', 'Bhadrak', 'Baripada', 'Jharsuguda', 'Angul', 'Talcher', 'Kalinganagar', 'Paradip', 'Jajpur', 'Kendrapara', 'Dhenkanal', 'Keonjhar', 'Jeypore', 'Rayagada', 'Bargarh'],
  'Puducherry': <String>['Puducherry', 'Karaikal', 'Mahe', 'Yanam'],
  'Punjab': <String>['Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala', 'Bathinda', 'Mohali', 'Hoshiarpur', 'Pathankot', 'Moga', 'Batala', 'Abohar', 'Malerkotla', 'Khanna', 'Phagwara', 'Muktsar', 'Barnala', 'Rajpura', 'Firozpur', 'Kapurthala', 'Mandi Gobindgarh', 'Zirakpur'],
  'Rajasthan': <String>['Jaipur', 'Jodhpur', 'Kota', 'Bikaner', 'Ajmer', 'Udaipur', 'Bhilwara', 'Alwar', 'Bhiwadi', 'Neemrana', 'Bharatpur', 'Sikar', 'Pali', 'Sri Ganganagar', 'Tonk', 'Kishangarh', 'Beawar', 'Hanumangarh', 'Dhaulpur', 'Chittorgarh', 'Jhunjhunu', 'Barmer', 'Nagaur', 'Banswara', 'Sawai Madhopur'],
  'Sikkim': <String>['Gangtok', 'Namchi', 'Gyalshing', 'Mangan', 'Rangpo', 'Singtam', 'Jorethang'],
  'Tamil Nadu': <String>['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem', 'Tiruppur', 'Erode', 'Vellore', 'Thoothukudi', 'Tirunelveli', 'Hosur', 'Thanjavur', 'Dindigul', 'Kanchipuram', 'Sriperumbudur', 'Oragadam', 'Chengalpattu', 'Tiruvallur', 'Gummidipoondi', 'Nagercoil', 'Karur', 'Kumbakonam', 'Cuddalore', 'Rajapalayam', 'Sivakasi', 'Pudukkottai', 'Ranipet', 'Ambur', 'Krishnagiri', 'Namakkal'],
  'Telangana': <String>['Hyderabad', 'Secunderabad', 'Warangal', 'Nizamabad', 'Karimnagar', 'Khammam', 'Ramagundam', 'Mahbubnagar', 'Nalgonda', 'Adilabad', 'Suryapet', 'Siddipet', 'Miryalaguda', 'Sangareddy', 'Patancheru', 'Medak', 'Mancherial', 'Jagtial'],
  'Tripura': <String>['Agartala', 'Udaipur', 'Dharmanagar', 'Kailashahar', 'Belonia', 'Ambassa'],
  'Uttar Pradesh': <String>['Lucknow', 'Kanpur', 'Ghaziabad', 'Noida', 'Greater Noida', 'Agra', 'Varanasi', 'Meerut', 'Prayagraj', 'Bareilly', 'Aligarh', 'Moradabad', 'Saharanpur', 'Gorakhpur', 'Firozabad', 'Jhansi', 'Muzaffarnagar', 'Mathura', 'Ayodhya', 'Rampur', 'Shahjahanpur', 'Hapur', 'Etawah', 'Mirzapur', 'Bulandshahr', 'Sambhal', 'Amroha', 'Hardoi', 'Fatehpur', 'Raebareli', 'Sitapur', 'Bahraich', 'Unnao', 'Jaunpur', 'Azamgarh', 'Ballia', 'Basti', 'Deoria', 'Ghazipur', 'Sultanpur', 'Gonda', 'Bijnor', 'Shamli', 'Baghpat', 'Loni', 'Modinagar', 'Khurja', 'Bhadohi'],
  'Uttarakhand': <String>['Dehradun', 'Haridwar', 'Roorkee', 'Haldwani', 'Rudrapur', 'Kashipur', 'Rishikesh', 'Pantnagar', 'Sitarganj', 'Selaqui', 'Kotdwar', 'Almora', 'Nainital', 'Pithoragarh', 'Ramnagar'],
  'West Bengal': <String>['Kolkata', 'Howrah', 'Durgapur', 'Asansol', 'Siliguri', 'Bardhaman', 'Malda', 'Haldia', 'Kharagpur', 'Baharampur', 'Habra', 'Krishnanagar', 'Medinipur', 'Jalpaiguri', 'Balurghat', 'Bankura', 'Raiganj', 'Purulia', 'Kalyani', 'Barrackpore', 'Bally', 'Serampore', 'Chandannagar', 'Uluberia', 'Hugli-Chinsurah'],
};

/// Common alternative spellings (device geocoders, older names). Used ONLY to
/// pick city suggestions — the value the worker sees and submits is never
/// rewritten.
const Map<String, String> _kStateAliases = <String, String>{
  'nct of delhi': 'Delhi',
  'national capital territory of delhi': 'Delhi',
  'new delhi': 'Delhi',
  'orissa': 'Odisha',
  'pondicherry': 'Puducherry',
  'uttaranchal': 'Uttarakhand',
  'jammu & kashmir': 'Jammu and Kashmir',
  'andaman & nicobar islands': 'Andaman and Nicobar Islands',
  'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
  'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
};

/// Canonical state for [raw] (case/space-insensitive, alias-aware), or null.
String? canonicalIndianState(String raw) {
  final String key = raw.trim().toLowerCase().replaceAll(RegExp(r'\s+'), ' ');
  if (key.isEmpty) return null;
  for (final String s in kIndianStates) {
    if (s.toLowerCase() == key) return s;
  }
  return _kStateAliases[key];
}

/// City suggestions for [state]; empty (never null) for an unknown state.
List<String> citiesForIndianState(String state) {
  final String? canonical = canonicalIndianState(state);
  if (canonical == null) return const <String>[];
  return _kCitiesByState[canonical] ?? const <String>[];
}
