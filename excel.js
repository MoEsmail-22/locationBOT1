const crypto = require("crypto");
const XLSX = require("xlsx");

const HEADER_ALIASES = {
  primary_phone: ["الهاتف 001", "phone", "primary_phone"],
  customer_name: ["اسم العميل", "customer_name", "name"],
  duplicate_phone: ["الهاتف 0012", "duplicate_phone"],
  phone_2: ["الهاتف 002", "phone_2", "phone2"],
  phone_3: ["الهاتف 003", "phone_3", "phone3"],
  governorate: ["المحافظة", "governorate", "city"],
  zone: ["zone", "Zone"],
  area: ["area", "Area"],
  address_1: ["العنوان", "address", "address_1"],
  address_2: ["العنوان 02", "address_2"],
  address_3: ["العنوان 03", "address_3"],
  notes: ["ملحوظة", "notes", "note"],
};

function normalizeHeader(value) {
  return String(value || "").trim();
}

function normalizeArabicDigits(value) {
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  const persian = "۰۱۲۳۴۵۶۷۸۹";

  return String(value || "").replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabicIndex = arabic.indexOf(digit);
    if (arabicIndex !== -1) return String(arabicIndex);
    return String(persian.indexOf(digit));
  });
}

function cleanText(value) {
  return (
    String(value || "")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

function normalizePhone(value) {
  if (value === undefined || value === null) return null;

  let phone = normalizeArabicDigits(value).replace(/[^\d+]/g, "");
  if (!phone) return null;

  if (phone.startsWith("+20")) {
    phone = `0${phone.slice(3)}`;
  } else if (phone.startsWith("20") && phone.length === 12) {
    phone = `0${phone.slice(2)}`;
  } else if (phone.startsWith("1") && phone.length === 10) {
    phone = `0${phone}`;
  }

  return phone;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function findHeaderRow(matrix) {
  const headerWords = ["اسم العميل", "الهاتف 001", "المحافظة", "العنوان"];

  const index = matrix.findIndex((row) =>
    headerWords.some((word) =>
      row.some((cell) => normalizeHeader(cell) === word),
    ),
  );

  return index === -1 ? 0 : index;
}

function mapRow(headers, row) {
  const mapped = {};

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const index = headers.findIndex((header) =>
      aliases.some(
        (alias) =>
          normalizeHeader(alias).toLowerCase() === header.toLowerCase(),
      ),
    );

    mapped[field] = index === -1 ? "" : row[index];
  }

  return mapped;
}

function makeHash(profile) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(profile))
    .digest("hex");
}

function parseCustomerProfilesFromExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];

  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  const headerRowIndex = findHeaderRow(matrix);
  const headers = matrix[headerRowIndex].map(normalizeHeader);
  const dataRows = matrix.slice(headerRowIndex + 1);

  return dataRows
    .map((row, rowIndex) => {
      const mapped = mapRow(headers, row);
      const phones = unique([
        normalizePhone(mapped.duplicate_phone),
        normalizePhone(mapped.phone_2),
        normalizePhone(mapped.phone_3),
      ]);
      const addresses = unique([
        cleanText(mapped.address_1),
        cleanText(mapped.address_2),
        cleanText(mapped.address_3),
      ]);

      const profile = {
        customerName: cleanText(mapped.customer_name),
        primaryPhone: normalizePhone(mapped.primary_phone),
        duplicateCheckPhone: normalizePhone(mapped.duplicate_phone),
        phones,
        governorate: cleanText(mapped.governorate),
        zone: cleanText(mapped.zone),
        area: cleanText(mapped.area),
        addresses,
        notes: cleanText(mapped.notes),
        rawData: Object.fromEntries(
          headers.map((header, index) => [header, row[index] || ""]),
        ),
      };

      // INCLUDE rowIndex IN HASH SO DUPLICATES ARE SAVED SEPARATELY
      profile.sourceHash = makeHash({ ...profile, _rowIndex: rowIndex });
      return profile;
    })
    .filter(
      (profile) =>
        profile.customerName ||
        profile.phones.length ||
        profile.addresses.length,
    );
}

module.exports = {
  parseCustomerProfilesFromExcel,
  normalizePhone,
};
