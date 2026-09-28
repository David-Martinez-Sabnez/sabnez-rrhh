namespace sabnez.calendars;

using {cuid, managed} from '@sap/cds/common';

@assert.unique: {country: [countryCode]}
entity WorkCalendars : cuid, managed {
  code              : String(30);
  name              : String(120);
  countryCode       : String(2)   @mandatory;
  country           : Association to Countries
                        on country.code = countryCode;
  subdivisionCode   : String(12);
  hoursPerDay       : Decimal(4, 2) default 8;
  monday            : Boolean default true;
  tuesday           : Boolean default true;
  wednesday         : Boolean default true;
  thursday          : Boolean default true;
  friday            : Boolean default true;
  saturday          : Boolean default false;
  sunday            : Boolean default false;
  active            : Boolean default true;
  lastSyncedYear    : String(4);
  lastSyncedAt      : Timestamp;
  lastSyncCount     : Integer;
  holidays          : Composition of many Holidays
                        on holidays.calendar = $self;
}

entity Countries {
  key code : String(2);
      name : String(120) @mandatory;
}

@assert.unique: {sourceKey: [calendar, source, externalKey]}
entity Holidays : cuid, managed {
  calendar          : Association to WorkCalendars @mandatory;
  date              : Date @mandatory;
  year              : String(4) @mandatory;
  name              : String(180) @mandatory;
  countryCode       : String(2) @mandatory;
  subdivisionCodes  : String(500);
  nationalHoliday   : Boolean default true;
  holidayType       : String(40) default 'Public';
  source            : String(40) default 'MANUAL';
  externalKey       : String(500);
  manualOverride    : Boolean default false;
  active            : Boolean default true;
}
