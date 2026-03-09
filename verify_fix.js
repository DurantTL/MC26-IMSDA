// verify_fix.js

const cData = [
    ['Registration ID', 'Tents', 'Trailer', 'Kitchen Canopy', 'Total SqFt', 'Camp Next To'],
    ['12345', '2', '0', '1', '500', 'Pathfinders']
];

const cCol = {};
cData[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h, i) => { cCol[h] = i; });

console.log('Column Mapping:', cCol);

const job = { registrationId: '12345' };

console.log('\n--- Testing Buggy Logic ---');
for (let i = 1; i < cData.length; i++) {
    const idxBuggy = cCol['registrationid'] || -1;
    console.log(`Index used (Buggy): ${idxBuggy}`);

    // cData[i][-1] is undefined
    const valueBuggy = cData[i][idxBuggy];
    console.log(`Value found (Buggy): ${valueBuggy}`);

    if (String(valueBuggy || '') === job.registrationId) {
        console.log('Buggy: Match found! (Unexpected)');
    } else {
        console.log('Buggy: No match found (Expected failure due to falsy 0)');
    }
}

console.log('\n--- Testing Fixed Logic ---');
for (let i = 1; i < cData.length; i++) {
    const regIdx = cCol['registrationid'] ?? -1;
    console.log(`Index used (Fixed): ${regIdx}`);

    const valueFixed = cData[i][regIdx];
    console.log(`Value found (Fixed): ${valueFixed}`);

    if (String(valueFixed || '') === job.registrationId) {
        console.log('Fixed: Match found! (Success)');

        const tents = String(cData[i][cCol['tents'] ?? -1] || '');
        const trailer = String(cData[i][cCol['trailer'] ?? -1] || '');
        const canopy = String(cData[i][cCol['kitchencanopy'] ?? -1] || '');
        const sqft = String(cData[i][cCol['totalsqft'] ?? -1] || '');
        const nextTo = String(cData[i][cCol['campnextto'] ?? -1] || '');

        console.log(`Tents: ${tents}`);
        console.log(`Trailer: ${trailer}`);
        console.log(`Canopy: ${canopy}`);
        console.log(`SqFt: ${sqft}`);
        console.log(`Next To: ${nextTo}`);

    } else {
        console.log('Fixed: No match found (Unexpected failure)');
    }
}
