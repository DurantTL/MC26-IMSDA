// verify_logic_final.js

// Mock data structure
const cData = [
    ['Registration ID', 'Tents', 'Trailer', 'Kitchen Canopy', 'Total SqFt', 'Camp Next To'],
    ['12345', '2', '0', '1', '500', 'Pathfinders']
];

// Mock column mapping
const cCol = {};
cData[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { cCol[h] = i; });

const job = { registrationId: '12345' };

// Simulate the FIXED loop
let matchFound = false;
let campingDetails = {};

for (let i = 1; i < cData.length; i++) {
    const regIdx = cCol['registrationid'] ?? -1;
    if (String(cData[i][regIdx] || '') === job.registrationId) {
        matchFound = true;
        campingDetails.tents = String(cData[i][cCol['tents'] ?? -1] || '');
        campingDetails.trailer = String(cData[i][cCol['trailer'] ?? -1] || '');
        campingDetails.kitchenCanopy = String(cData[i][cCol['kitchencanopy'] ?? -1] || '');
        campingDetails.totalSqft = String(cData[i][cCol['totalsqft'] ?? -1] || '');
        campingDetails.campNextTo = String(cData[i][cCol['campnextto'] ?? -1] || '');
        break;
    }
}

if (matchFound) {
    console.log('SUCCESS: Logic found the registration.');
    if (campingDetails.tents === '2' && campingDetails.trailer === '0') {
        console.log('SUCCESS: Extracted correct data.');
    } else {
        console.log('FAILURE: Data extraction incorrect.');
    }
} else {
    console.log('FAILURE: Logic did not find the registration.');
}
