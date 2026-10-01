import Foundation

public enum JournalDates {
    public static func calendar(timeZone: TimeZone = .current) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    public static func key(_ date: Date, calendar: Calendar = calendar()) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }

    public static func date(_ key: String, calendar: Calendar = calendar()) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12)),
              self.key(date, calendar: calendar) == key else { return nil }
        return date
    }

    /// Always include today; after 18:00 expose tomorrow (through Monday on Friday).
    public static func available(now: Date = Date(), calendar: Calendar = calendar()) -> [String] {
        let count = calendar.component(.hour, from: now) >= 18
            ? (calendar.component(.weekday, from: now) == 6 ? 3 : 1) : 0
        return (0...count).compactMap { calendar.date(byAdding: .day, value: $0, to: now) }
            .map { key($0, calendar: calendar) }
    }
}
