package server

import (
	"math"
	"time"
)

const (
	xiaomiScaleHeightCM = 174.0
	xiaomiScaleSex      = "male"
)

var xiaomiScaleDOB = time.Date(1989, time.July, 2, 0, 0, 0, 0, time.UTC)

type xiaomiScaleMetrics struct {
	WeightKG         float64 `json:"weight_kg"`
	ImpedanceOhms    int     `json:"impedance_ohms"`
	BMI              float64 `json:"bmi"`
	BasalMetabolism  float64 `json:"basal_metabolism"`
	VisceralFat      float64 `json:"visceral_fat"`
	LeanBodyMass     float64 `json:"lean_body_mass"`
	BodyFat          float64 `json:"body_fat"`
	Water            float64 `json:"water"`
	BoneMass         float64 `json:"bone_mass"`
	MuscleMass       float64 `json:"muscle_mass"`
	Protein          float64 `json:"protein"`
	BodyType         string  `json:"body_type"`
	MetabolicAge     float64 `json:"metabolic_age"`
	Source           string  `json:"source"`
	ProfileHeightCM  float64 `json:"profile_height_cm"`
	ProfileSex       string  `json:"profile_sex"`
	ProfileBirthDate string  `json:"profile_birth_date"`
}

type xiaomiBodyCalculator struct {
	weight   float64
	height   float64
	age      float64
	sex      string
	imp      float64
	bodyType []string
}

func calculateXiaomiScaleMetrics(weightKG float64, impedanceOhms int, measuredAt time.Time) xiaomiScaleMetrics {
	calc := xiaomiBodyCalculator{
		weight: weightKG,
		height: xiaomiScaleHeightCM,
		age:    ageAt(xiaomiScaleDOB, measuredAt),
		sex:    xiaomiScaleSex,
		imp:    float64(impedanceOhms),
		bodyType: []string{
			"obese", "overweight", "thick_set", "lack_exercise", "balanced", "balanced_muscular", "skinny", "balanced_skinny", "skinny_muscular",
		},
	}
	bodyTypeIndex := calc.bodyTypeIndex()
	return xiaomiScaleMetrics{
		WeightKG:         round2(weightKG),
		ImpedanceOhms:    impedanceOhms,
		BMI:              round2(calc.bmi()),
		BasalMetabolism:  round2(calc.bmr()),
		VisceralFat:      round2(calc.visceralFat()),
		LeanBodyMass:     round2(calc.lbmCoefficient()),
		BodyFat:          round2(calc.fatPercentage()),
		Water:            round2(calc.waterPercentage()),
		BoneMass:         round2(calc.boneMass()),
		MuscleMass:       round2(calc.muscleMass()),
		Protein:          round2(calc.proteinPercentage()),
		BodyType:         calc.bodyType[bodyTypeIndex],
		MetabolicAge:     math.Round(calc.metabolicAge()),
		Source:           "xiaomi_scale_2",
		ProfileHeightCM:  xiaomiScaleHeightCM,
		ProfileSex:       xiaomiScaleSex,
		ProfileBirthDate: xiaomiScaleDOB.Format("2006-01-02"),
	}
}

func ageAt(dob time.Time, at time.Time) float64 {
	return math.Abs(at.Sub(dob).Hours() / 24 / 365)
}

func clamp(value float64, minimum float64, maximum float64) float64 {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func round2(value float64) float64 {
	return math.Round(value*100) / 100
}

func (c xiaomiBodyCalculator) lbmCoefficient() float64 {
	lbm := (c.height * 9.058 / 100) * (c.height / 100)
	lbm += c.weight*0.32 + 12.226
	lbm -= c.imp * 0.0068
	lbm -= c.age * 0.0542
	return lbm
}

func (c xiaomiBodyCalculator) bmr() float64 {
	var bmr float64
	if c.sex == "female" {
		bmr = 864.6 + c.weight*10.2036 - c.height*0.39336 - c.age*6.204
		if bmr > 2996 {
			bmr = 5000
		}
	} else {
		bmr = 877.8 + c.weight*14.916 - c.height*0.726 - c.age*8.976
		if bmr > 2322 {
			bmr = 5000
		}
	}
	return clamp(bmr, 500, 10000)
}

func (c xiaomiBodyCalculator) fatPercentage() float64 {
	constant := 0.8
	if c.sex == "female" && c.age <= 49 {
		constant = 9.25
	} else if c.sex == "female" && c.age > 49 {
		constant = 7.25
	}

	coefficient := 1.0
	if c.sex == "male" && c.weight < 61 {
		coefficient = 0.98
	} else if c.sex == "female" && c.weight > 60 {
		coefficient = 0.96
		if c.height > 160 {
			coefficient *= 1.03
		}
	} else if c.sex == "female" && c.weight < 50 {
		coefficient = 1.02
		if c.height > 160 {
			coefficient *= 1.03
		}
	}

	fat := (1.0 - (((c.lbmCoefficient() - constant) * coefficient) / c.weight)) * 100
	if fat > 63 {
		fat = 75
	}
	return clamp(fat, 5, 75)
}

func (c xiaomiBodyCalculator) waterPercentage() float64 {
	water := (100 - c.fatPercentage()) * 0.7
	coefficient := 0.98
	if water <= 50 {
		coefficient = 1.02
	}
	if water*coefficient >= 65 {
		water = 75
	}
	return clamp(water*coefficient, 35, 75)
}

func (c xiaomiBodyCalculator) boneMass() float64 {
	base := 0.18016894
	if c.sex == "female" {
		base = 0.245691014
	}
	bone := (base - (c.lbmCoefficient() * 0.05158)) * -1
	if bone > 2.2 {
		bone += 0.1
	} else {
		bone -= 0.1
	}
	if c.sex == "female" && bone > 5.1 {
		bone = 8
	} else if c.sex == "male" && bone > 5.2 {
		bone = 8
	}
	return clamp(bone, 0.5, 8)
}

func (c xiaomiBodyCalculator) muscleMass() float64 {
	muscle := c.weight - ((c.fatPercentage() * 0.01) * c.weight) - c.boneMass()
	if c.sex == "female" && muscle >= 84 {
		muscle = 120
	} else if c.sex == "male" && muscle >= 93.5 {
		muscle = 120
	}
	return clamp(muscle, 10, 120)
}

func (c xiaomiBodyCalculator) visceralFat() float64 {
	var vfal float64
	if c.sex == "female" {
		if c.weight > (13-(c.height*0.5))*-1 {
			subsubcalc := ((c.height * 1.45) + (c.height*0.1158)*c.height) - 120
			subcalc := c.weight * 500 / subsubcalc
			vfal = (subcalc - 6) + (c.age * 0.07)
		} else {
			subcalc := 0.691 + (c.height * -0.0024) + (c.height * -0.0024)
			vfal = (((c.height * 0.027) - (subcalc * c.weight)) * -1) + (c.age * 0.07) - c.age
		}
	} else {
		if c.height < c.weight*1.6 {
			subcalc := ((c.height * 0.4) - (c.height * (c.height * 0.0826))) * -1
			vfal = ((c.weight * 305) / (subcalc + 48)) - 2.9 + (c.age * 0.15)
		} else {
			subcalc := 0.765 + c.height*-0.0015
			vfal = (((c.height * 0.143) - (c.weight * subcalc)) * -1) + (c.age * 0.15) - 5.0
		}
	}
	return clamp(vfal, 1, 50)
}

func (c xiaomiBodyCalculator) bmi() float64 {
	return clamp(c.weight/((c.height/100)*(c.height/100)), 10, 90)
}

func (c xiaomiBodyCalculator) proteinPercentage() float64 {
	protein := (c.muscleMass() / c.weight) * 100
	protein -= c.waterPercentage()
	return clamp(protein, 5, 32)
}

func (c xiaomiBodyCalculator) bodyTypeIndex() int {
	fatScale := c.fatPercentageScale()
	factor := 1
	if c.fatPercentage() > fatScale[2] {
		factor = 0
	} else if c.fatPercentage() < fatScale[1] {
		factor = 2
	}
	muscleScale := c.muscleMassScale()
	if c.muscleMass() > muscleScale[1] {
		return 2 + (factor * 3)
	}
	if c.muscleMass() < muscleScale[0] {
		return factor * 3
	}
	return 1 + (factor * 3)
}

func (c xiaomiBodyCalculator) metabolicAge() float64 {
	if c.sex == "female" {
		return clamp((c.height*-1.1165)+(c.weight*1.5784)+(c.age*0.4615)+(c.imp*0.0415)+83.2548, 15, 80)
	}
	return clamp((c.height*-0.7471)+(c.weight*0.9161)+(c.age*0.4184)+(c.imp*0.0517)+54.2267, 15, 80)
}

func (c xiaomiBodyCalculator) fatPercentageScale() [4]float64 {
	scales := []struct {
		min    float64
		max    float64
		female [4]float64
		male   [4]float64
	}{
		{0, 12, [4]float64{12, 21, 30, 34}, [4]float64{7, 16, 25, 30}},
		{12, 14, [4]float64{15, 24, 33, 37}, [4]float64{7, 16, 25, 30}},
		{14, 16, [4]float64{18, 27, 36, 40}, [4]float64{7, 16, 25, 30}},
		{16, 18, [4]float64{20, 28, 37, 41}, [4]float64{7, 16, 25, 30}},
		{18, 40, [4]float64{21, 28, 35, 40}, [4]float64{11, 17, 22, 27}},
		{40, 60, [4]float64{22, 29, 36, 41}, [4]float64{12, 18, 23, 28}},
		{60, 100, [4]float64{23, 30, 37, 42}, [4]float64{14, 20, 25, 30}},
	}
	for _, scale := range scales {
		if c.age >= scale.min && c.age < scale.max {
			if c.sex == "female" {
				return scale.female
			}
			return scale.male
		}
	}
	return scales[len(scales)-1].male
}

func (c xiaomiBodyCalculator) muscleMassScale() [2]float64 {
	if c.sex == "female" {
		if c.height >= 160 {
			return [2]float64{36.5, 42.6}
		}
		if c.height >= 150 {
			return [2]float64{32.9, 37.6}
		}
		return [2]float64{29.1, 34.8}
	}
	if c.height >= 170 {
		return [2]float64{49.4, 59.5}
	}
	if c.height >= 160 {
		return [2]float64{44, 52.5}
	}
	return [2]float64{38.5, 46.6}
}
